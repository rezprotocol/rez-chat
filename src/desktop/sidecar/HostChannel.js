import readline from "node:readline";
import { randomUUID } from "node:crypto";

/**
 * Line-delimited JSON-RPC between the Node sidecar and its host process
 * (the Tauri shell) over the sidecar's own stdio.
 *
 * Every protocol line is prefixed with MARKER so the host can separate
 * protocol frames from ordinary log output sharing stdout. Frames:
 *
 *   {kind:"req", id, op, params}        request (either direction)
 *   {kind:"res", id, ok, result|error}  response to a req
 *   {kind:"evt", op, params}            one-way notification (either direction)
 *
 * Sidecar -> host frames go to `output` (stdout); host -> sidecar frames
 * arrive on `input` (stdin). The first sidecar frame after boot is the
 * ready notification: {kind:"evt", op:"ready", params:{port, pid, instanceId}}.
 *
 * `input` reaching EOF means the host process is gone (the OS closes the
 * pipe when the parent dies, even on SIGKILL) — `onParentGone` fires once.
 * This is the PRIMARY parent-death detector; ParentWatchdog's ppid polling
 * is the backstop.
 */
export class HostChannel {
  static MARKER = "@@REZ@@";

  #input;
  #output;
  #onRequest;
  #onParentGone;
  #logger;
  #pending;
  #rl;
  #parentGoneFired;
  #outputDead;
  #started;

  constructor({
    input = process.stdin,
    output = process.stdout,
    onRequest = null,
    onParentGone = null,
    logger = console,
  } = {}) {
    if (!input || typeof input.on !== "function") {
      throw new Error("HostChannel requires input stream");
    }
    if (!output || typeof output.write !== "function") {
      throw new Error("HostChannel requires output stream");
    }
    this.#input = input;
    this.#output = output;
    this.#onRequest = typeof onRequest === "function" ? onRequest : null;
    this.#onParentGone = typeof onParentGone === "function" ? onParentGone : null;
    this.#logger = logger || console;
    this.#pending = new Map();
    this.#rl = null;
    this.#parentGoneFired = false;
    this.#outputDead = false;
    this.#started = false;
  }

  start() {
    if (this.#started) return this;
    this.#started = true;
    // Stream write errors (EPIPE once the host is gone) surface as async
    // 'error' events, not sync throws — without a listener they crash the
    // process mid-shutdown. A dead stdout means the host is gone: stop
    // writing and run the same parent-gone shutdown the stdin-EOF path uses.
    this.#output.on("error", (err) => {
      this.#outputDead = true;
      if (!err || err.code !== "EPIPE") {
        this.#warn("stdout error", err);
      }
      this.#fireParentGone("stdout closed");
    });
    this.#rl = readline.createInterface({ input: this.#input, terminal: false });
    this.#rl.on("line", (line) => {
      this.#handleLine(line).catch((err) => {
        this.#warn("frame handling failed", err);
      });
    });
    // readline emits "close" when the input stream ends — i.e. the host
    // process died or deliberately closed our stdin. Either way: shut down.
    this.#rl.on("close", () => this.#fireParentGone("stdin closed"));
    this.#input.on("error", (err) => {
      this.#warn("stdin error", err);
      this.#fireParentGone("stdin error");
    });
    return this;
  }

  stop() {
    if (this.#rl) {
      const rl = this.#rl;
      this.#rl = null;
      rl.removeAllListeners("close");
      rl.close();
    }
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(this.#channelClosedError());
    }
    this.#pending.clear();
  }

  /** Send a one-way notification to the host. */
  notify(op, params = {}) {
    this.#writeFrame({ kind: "evt", op: String(op), params });
  }

  /**
   * Send a request to the host and await its response. Rejects on timeout
   * or channel teardown — callers must handle failure explicitly (the host
   * may be gone).
   */
  request(op, params = {}, { timeoutMs = 15000 } = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const err = new Error("HostChannel request '" + op + "' timed out");
        err.code = "HOST_CHANNEL_TIMEOUT";
        reject(err);
      }, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#writeFrame({ kind: "req", id, op: String(op), params });
    });
  }

  async #handleLine(line) {
    const raw = String(line || "");
    const idx = raw.indexOf(HostChannel.MARKER);
    if (idx !== 0) return; // not a protocol line — ignore
    let frame = null;
    try {
      frame = JSON.parse(raw.slice(HostChannel.MARKER.length));
    } catch (err) {
      this.#warn("unparseable frame", err);
      return;
    }
    if (!frame || typeof frame !== "object" || typeof frame.kind !== "string") {
      this.#warn("malformed frame", null);
      return;
    }
    if (frame.kind === "res") {
      const entry = this.#pending.get(frame.id);
      if (!entry) return;
      this.#pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok === true) {
        entry.resolve(frame.result);
      } else {
        const errObj = frame.error && typeof frame.error === "object" ? frame.error : {};
        const err = new Error(errObj.message ? String(errObj.message) : "Host request failed");
        err.code = errObj.code ? String(errObj.code) : "HOST_REQUEST_ERROR";
        entry.reject(err);
      }
      return;
    }
    if (frame.kind === "req" || frame.kind === "evt") {
      if (!this.#onRequest) {
        if (frame.kind === "req") {
          this.#writeFrame({
            kind: "res",
            id: frame.id,
            ok: false,
            error: { message: "No request handler", code: "NO_HANDLER" },
          });
        }
        return;
      }
      const op = typeof frame.op === "string" ? frame.op : "";
      const params = frame.params == null ? {} : frame.params;
      try {
        const result = await this.#onRequest(op, params);
        if (frame.kind === "req") {
          this.#writeFrame({ kind: "res", id: frame.id, ok: true, result: result == null ? null : result });
        }
      } catch (err) {
        if (frame.kind === "req") {
          this.#writeFrame({
            kind: "res",
            id: frame.id,
            ok: false,
            error: {
              message: err && err.message ? String(err.message) : "Request failed",
              code: err && err.code ? String(err.code) : "REQUEST_ERROR",
            },
          });
        } else {
          this.#warn("notification handler failed", err);
        }
      }
    }
  }

  #writeFrame(frame) {
    // Once the host is gone the pipe is dead — further writes only EPIPE.
    if (this.#outputDead || this.#parentGoneFired) return;
    try {
      this.#output.write(HostChannel.MARKER + JSON.stringify(frame) + "\n");
    } catch (err) {
      this.#warn("write failed", err);
    }
  }

  #fireParentGone(reason) {
    if (this.#parentGoneFired) return;
    this.#parentGoneFired = true;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(this.#channelClosedError());
    }
    this.#pending.clear();
    if (this.#onParentGone) {
      this.#onParentGone(reason);
    }
  }

  #channelClosedError() {
    const err = new Error("HostChannel closed");
    err.code = "HOST_CHANNEL_CLOSED";
    return err;
  }

  #warn(message, err) {
    if (this.#logger && typeof this.#logger.warn === "function") {
      this.#logger.warn("[host-channel] " + message, err && err.message ? err.message : err);
    }
  }
}
