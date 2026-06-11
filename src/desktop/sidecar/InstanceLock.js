import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Per-data-dir sidecar instance lock (zombie-prevention layer 4).
 *
 * The sidecar writes `<userData>/sidecar.lock` = {pid, port, instanceId,
 * startedAtMs} after binding its shell port and removes it on clean exit.
 * At the next boot, `cleanupStale()` inspects any leftover lock:
 *
 *   - lock pid dead                          -> remove stale lock
 *   - lock pid alive but NOT verifiably ours -> remove stale lock,
 *                                               never touch the process
 *   - lock pid alive AND verified ours       -> SIGTERM, bounded wait,
 *                                               SIGKILL, remove lock
 *
 * "Verifiably ours" requires BOTH:
 *   (a) the process command line contains CMDLINE_MARKER (every sidecar is
 *       spawned with the `--rez-sidecar` argv marker), and
 *   (b) GET /health on the locked port answers with the lock's instanceId.
 * PID reuse fails (a); an unrelated rez process on a reused port fails (b).
 */
export class InstanceLock {
  static CMDLINE_MARKER = "--rez-sidecar";

  #lockPath;
  #instanceId;
  #logger;
  #processRef;

  constructor({ lockPath, instanceId, processRef = process, logger = console } = {}) {
    if (!lockPath || typeof lockPath !== "string") {
      throw new Error("InstanceLock requires lockPath");
    }
    if (!instanceId || typeof instanceId !== "string") {
      throw new Error("InstanceLock requires instanceId");
    }
    this.#lockPath = lockPath;
    this.#instanceId = instanceId;
    this.#processRef = processRef;
    this.#logger = logger || console;
  }

  get lockPath() {
    return this.#lockPath;
  }

  /**
   * Inspect and clear any stale lock left by a previous run. Returns a
   * summary {action} for logging/tests:
   *   "none" | "removed-invalid" | "removed-dead" | "removed-unverified" | "killed"
   */
  async cleanupStale({ healthTimeoutMs = 1500, killWaitMs = 3000 } = {}) {
    let raw = null;
    try {
      raw = fs.readFileSync(this.#lockPath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return { action: "none" };
      throw err;
    }
    let lock = null;
    try {
      lock = JSON.parse(raw);
    } catch (err) {
      this.#removeLockFile();
      return { action: "removed-invalid" };
    }
    const pid = lock && Number.isInteger(lock.pid) ? lock.pid : null;
    if (!pid || pid <= 0) {
      this.#removeLockFile();
      return { action: "removed-invalid" };
    }
    if (!this.#pidAlive(pid)) {
      this.#removeLockFile();
      return { action: "removed-dead" };
    }

    const cmdlineOk = await this.#cmdlineHasMarker(pid);
    const healthOk = cmdlineOk
      ? await this.#healthMatchesInstance(lock, healthTimeoutMs)
      : false;
    if (!cmdlineOk || !healthOk) {
      // A live process we cannot verify is NOT ours to kill (PID reuse,
      // foreign process on a reused port). Drop the stale lock and move on.
      this.#removeLockFile();
      return { action: "removed-unverified" };
    }

    await this.#terminate(pid, killWaitMs);
    this.#removeLockFile();
    return { action: "killed" };
  }

  /** Write the lock for this instance. Call after the shell port is bound. */
  write({ pid = this.#processRef.pid, port } = {}) {
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("InstanceLock.write requires bound port");
    }
    const payload = JSON.stringify({
      pid,
      port,
      instanceId: this.#instanceId,
      startedAtMs: Date.now(),
    });
    fs.mkdirSync(path.dirname(this.#lockPath), { recursive: true });
    const tmpPath = this.#lockPath + ".tmp";
    fs.writeFileSync(tmpPath, payload, { encoding: "utf8" });
    fs.renameSync(tmpPath, this.#lockPath);
  }

  /** Remove the lock iff it still belongs to this instance. */
  release() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.#lockPath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return;
      this.#warn("release read failed", err);
      return;
    }
    try {
      const lock = JSON.parse(raw);
      if (lock && lock.instanceId === this.#instanceId) {
        this.#removeLockFile();
      }
    } catch (err) {
      // Unparseable lock under our path: clear it rather than leak it.
      this.#removeLockFile();
    }
  }

  #pidAlive(pid) {
    try {
      this.#processRef.kill(pid, 0);
      return true;
    } catch (err) {
      if (err && err.code === "EPERM") {
        // Exists but owned by another user — cannot be our sidecar (same
        // user spawns it); treat as not-ours, handled by verification.
        return true;
      }
      return false;
    }
  }

  async #cmdlineHasMarker(pid) {
    try {
      if (this.#processRef.platform === "win32") {
        const { stdout } = await execFileAsync("powershell", [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ]);
        return String(stdout || "").includes(InstanceLock.CMDLINE_MARKER);
      }
      const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
      return String(stdout || "").includes(InstanceLock.CMDLINE_MARKER);
    } catch (err) {
      this.#warn("cmdline probe failed for pid " + pid, err);
      return false;
    }
  }

  #healthMatchesInstance(lock, timeoutMs) {
    const port = lock && Number.isInteger(lock.port) ? lock.port : null;
    const instanceId = lock && typeof lock.instanceId === "string" ? lock.instanceId : "";
    if (!port || port <= 0 || !instanceId) return Promise.resolve(false);
    return new Promise((resolve) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: timeoutMs },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
            if (body.length > 65536) req.destroy();
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              resolve(parsed && parsed.sidecar === true && parsed.instanceId === instanceId);
            } catch (err) {
              resolve(false);
            }
          });
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
  }

  async #terminate(pid, killWaitMs) {
    try {
      this.#processRef.kill(pid, "SIGTERM");
    } catch (err) {
      this.#warn("SIGTERM failed for pid " + pid, err);
      return;
    }
    const deadline = Date.now() + killWaitMs;
    while (Date.now() < deadline) {
      if (!this.#pidAlive(pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      this.#processRef.kill(pid, "SIGKILL");
    } catch (err) {
      if (!err || err.code !== "ESRCH") {
        this.#warn("SIGKILL failed for pid " + pid, err);
      }
    }
  }

  #removeLockFile() {
    try {
      fs.unlinkSync(this.#lockPath);
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        this.#warn("lock removal failed", err);
      }
    }
  }

  #warn(message, err) {
    if (this.#logger && typeof this.#logger.warn === "function") {
      this.#logger.warn("[instance-lock] " + message, err && err.message ? err.message : err);
    }
  }
}
