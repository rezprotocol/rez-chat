import { BaseServerService } from "../base/BaseServerService.js";
import { redactValue, redactText } from "../diagnostics/redact.js";

// How many recent error events a bundle carries. Bounded so a long-running app
// cannot grow the buffer without limit, and so a bundle stays small enough for
// a person to actually read before attaching it to a public issue.
const MAX_EVENTS = 100;

/**
 * ServerDiagnosticsService — assembles a redacted diagnostic snapshot a tester
 * can attach to a bug report (rez-chat#7).
 *
 * POSTURE (docs/DIAGNOSTICS.md): this service NEVER transmits anything. It
 * builds an object and hands it back over the bus; writing it to disk belongs
 * to the desktop layer, which owns paths, and sending it anywhere is the
 * user's own act of attaching a file. There is no endpoint, no third party,
 * and no opt-out to get wrong — for an E2EE client the only crash-reporting
 * posture that cannot leak is the one with nowhere to leak to.
 *
 * Everything that goes in is redacted at the boundary by
 * src/server/diagnostics/redact.js, on the assumption the bundle ends up in a
 * PUBLIC issue. Content, keys, invite codes and full identifiers never enter
 * the buffer in the first place — redaction happens on capture, not on export,
 * so a bundle cannot leak something that was retained in memory unredacted.
 */
export class ServerDiagnosticsService extends BaseServerService {
  #clock;
  #events;
  #appVersion;
  #startedAtMs;
  #droppedCount;

  constructor({ bus, ownerAccountId = null, appVersion = "", clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    this.#clock = clock;
    this.#events = [];
    this.#droppedCount = 0;
    this.#appVersion = typeof appVersion === "string" ? appVersion : "";
    this.#startedAtMs = clock();
    this._register("diagnostics", "snapshot", () => this.snapshot());
  }

  async start() {
    // React-if-you-care notification, not a directive: capturing diagnostics
    // must never sit in the path of the thing that went wrong.
    this.bus.on("app.error", (event) => this.recordError(event));
  }

  /**
   * Capture one error event, REDACTED AT CAPTURE. Synchronous and total: this
   * runs off the back of a failure, so it must not throw a second error on top
   * of the first one.
   */
  recordError(event) {
    try {
      const raw = event && typeof event === "object" ? event : { message: String(event) };
      const entry = {
        atMs: this.#clock(),
        source: raw.source == null ? null : redactText(String(raw.source)),
        severity: raw.severity == null ? "error" : String(raw.severity),
        message: raw.message == null ? null : redactText(String(raw.message)),
        err: raw.err === undefined ? null : redactValue(raw.err),
      };
      this.#events.push(entry);
      while (this.#events.length > MAX_EVENTS) {
        this.#events.shift();
        this.#droppedCount += 1;
      }
    } catch (err) {
      // Never rethrow: we are already handling somebody else's failure, and a
      // throw here would replace their error with ours. Report and move on.
      this.logger.error(
        "[ServerDiagnosticsService] failed to record an error event",
        err && err.message ? err.message : err,
      );
    }
  }

  /**
   * Build the bundle. Counts only — never rows, names, or contents. A count
   * tells us "groups are involved and there are ~12 of them", which is what
   * triages a report; the roster itself would tell us who the user talks to.
   */
  async snapshot() {
    const now = this.#clock();
    return {
      kind: "rez.chat.diagnostics.v1",
      generatedAtMs: now,
      note: "Redacted for public sharing. Contains no message content, keys, invite codes, or full account ids.",
      app: {
        version: this.#appVersion || "unknown",
        uptimeMs: now - this.#startedAtMs,
        platform: typeof process !== "undefined" && process.platform ? process.platform : "unknown",
        arch: typeof process !== "undefined" && process.arch ? process.arch : "unknown",
        nodeVersion: typeof process !== "undefined" && process.version ? process.version : "unknown",
      },
      capabilities: await this.#capabilities(),
      counts: await this.#counts(),
      recentErrors: this.#events.slice(),
      recentErrorsDropped: this.#droppedCount,
    };
  }

  async #capabilities() {
    // What the home node said it can do — the single most useful field for
    // triage, because it explains whole classes of "why can't I do X".
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.getSessionInfo !== "function") return null;
    try {
      const info = await sdk.getSessionInfo();
      const caps = info && info.capabilities ? info.capabilities : null;
      if (!caps) return null;
      return {
        durableInbox: caps.durableInbox === true,
        multiDeviceFanout: caps.multiDeviceFanout === true,
        delegatedDevices: caps.delegatedDevices === true,
      };
    } catch (err) {
      // A bundle is best-effort by nature; a missing section must not cost the
      // user the rest of it. Record the shape of the failure instead.
      return { unavailable: redactText(String(err && err.message ? err.message : err)) };
    }
  }

  async #counts() {
    const out = {};
    const stores = this.bus.stores || {};
    const pairs = [
      ["contacts", stores.contactStore, "listAll"],
      ["groups", stores.groupStore, "listGroups"],
      ["channels", stores.channelStore, "listAll"],
    ];
    for (const [name, store, method] of pairs) {
      if (!store || typeof store[method] !== "function") continue;
      try {
        const rows = await store[method]({ ownerAccountId: this.ownerAccountId });
        out[name] = Array.isArray(rows) ? rows.length : 0;
      } catch (err) {
        out[name] = null;
        this.logger.warn(
          "[ServerDiagnosticsService] count failed for " + name,
          err && err.message ? err.message : err,
        );
      }
    }
    return out;
  }
}
