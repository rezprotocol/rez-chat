/**
 * Backstop parent-death detector for the Node sidecar (zombie-prevention
 * layer 2b). The PRIMARY detector is stdin EOF via HostChannel — the OS
 * closes the stdio pipe when the host process dies by any means, including
 * SIGKILL. This watchdog covers the residual case where the pipe end was
 * inherited or stdin wasn't piped at all: it polls the parent pid.
 *
 * Detection: the parent pid is captured at start(). The sidecar is
 * considered orphaned when process.ppid changes (POSIX reparents orphans to
 * pid 1 / a subreaper) OR signalling the captured pid with signal 0 fails
 * (Windows: ppid is not live, but the existence probe is). PID reuse can
 * defeat the probe in theory — acceptable for a backstop; stdin EOF remains
 * the primary layer.
 */
export class ParentWatchdog {
  #pollMs;
  #onParentGone;
  #logger;
  #processRef;
  #timer;
  #initialPpid;
  #fired;

  constructor({ pollMs = 5000, onParentGone, processRef = process, logger = console } = {}) {
    if (typeof onParentGone !== "function") {
      throw new Error("ParentWatchdog requires onParentGone");
    }
    this.#pollMs = pollMs;
    this.#onParentGone = onParentGone;
    this.#logger = logger || console;
    this.#processRef = processRef;
    this.#timer = null;
    this.#initialPpid = null;
    this.#fired = false;
  }

  start() {
    if (this.#timer) return this;
    this.#initialPpid = this.#processRef.ppid;
    this.#timer = setInterval(() => this.#check(), this.#pollMs);
    // Never hold the process open: the watchdog exists to let it die.
    if (this.#timer && typeof this.#timer.unref === "function") {
      this.#timer.unref();
    }
    return this;
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #check() {
    if (this.#fired) return;
    const currentPpid = this.#processRef.ppid;
    if (Number.isInteger(this.#initialPpid) && currentPpid !== this.#initialPpid) {
      this.#fire("ppid changed " + this.#initialPpid + " -> " + currentPpid);
      return;
    }
    if (Number.isInteger(this.#initialPpid) && this.#initialPpid > 0) {
      try {
        this.#processRef.kill(this.#initialPpid, 0);
      } catch (err) {
        if (err && err.code === "ESRCH") {
          this.#fire("parent pid " + this.#initialPpid + " no longer exists");
          return;
        }
        // EPERM means the pid exists but belongs to another user — the
        // parent slot was either reused or elevated; either way we cannot
        // assert death from it. Leave detection to the ppid-change branch
        // and the stdin-EOF primary.
        if (!err || err.code !== "EPERM") {
          this.#warn("parent probe failed", err);
        }
      }
    }
  }

  #fire(reason) {
    if (this.#fired) return;
    this.#fired = true;
    this.stop();
    this.#onParentGone(reason);
  }

  #warn(message, err) {
    if (this.#logger && typeof this.#logger.warn === "function") {
      this.#logger.warn("[parent-watchdog] " + message, err && err.message ? err.message : err);
    }
  }
}
