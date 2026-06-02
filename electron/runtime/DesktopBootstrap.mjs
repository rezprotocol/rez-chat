/**
 * DesktopBootstrap — the desktop app's load state machine.
 *
 * Runs the startup phases IN ORDER, with a splash window visible the entire
 * time, so there is NEVER a "dock icon, no window, CPU spinning" state:
 *
 *   1. splash        — bring the splash window up immediately
 *   2. update-gate   — check for + apply an update BEFORE touching reznet. A
 *                      stale client updates here instead of failing to connect
 *                      to relays it's no longer compatible with.
 *   3. preconditions — verify we have everything we need (config, UI bundle,
 *                      vault path…) before going further.
 *   4. services      — start the backend (node + shell). The reznet connection
 *                      is non-blocking and surfaces its own state; the load
 *                      never blocks on it.
 *   5. handoff       — show the main window, then close the splash.
 *
 * Pure orchestration: every Electron/IO concern is INJECTED, so the phase
 * sequencing (update-before-reznet, preconditions-before-connect, fail-to-a-
 * state-never-a-hang) is unit-testable without Electron. Any phase failure
 * lands on the splash as a clear, specific state — never a silent hang.
 */

export const BOOT_PHASES = Object.freeze([
  "splash",
  "update",
  "preconditions",
  "services",
  "handoff",
]);

export class DesktopBootstrap {
  #splash;
  #updateGate;
  #checkPreconditions;
  #startBackend;
  #showMainWindow;
  #logger;

  /**
   * @param {{
   *   splash: { show(): Promise<void>|void, setStatus(phase: string, message: string): void, close(): Promise<void>|void },
   *   updateGate: (ctx: { setStatus(message: string): void }) => Promise<{ applying?: boolean }>,
   *   checkPreconditions: () => Promise<string[]>|string[],
   *   startBackend: () => Promise<any>,
   *   showMainWindow: (backend: any) => Promise<void>|void,
   *   logger?: Console,
   * }} deps
   */
  constructor({ splash, updateGate, checkPreconditions, startBackend, showMainWindow, logger = console } = {}) {
    const required = { splash, updateGate, checkPreconditions, startBackend, showMainWindow };
    for (const name of Object.keys(required)) {
      if (!required[name]) throw new Error(`DesktopBootstrap requires ${name}`);
    }
    if (typeof splash.show !== "function" || typeof splash.setStatus !== "function" || typeof splash.close !== "function") {
      throw new Error("DesktopBootstrap splash must implement show/setStatus/close");
    }
    this.#splash = splash;
    this.#updateGate = updateGate;
    this.#checkPreconditions = checkPreconditions;
    this.#startBackend = startBackend;
    this.#showMainWindow = showMainWindow;
    this.#logger = logger && typeof logger.error === "function" ? logger : console;
  }

  /**
   * Run the load sequence. Returns a discriminated result describing where it
   * ended: { ok } | { stopped: "updating" } | { stopped: "preconditions",
   * problems } | { stopped: "error", error }. It NEVER throws and NEVER leaves
   * the app without a window — every exit path sets a splash state.
   */
  async run() {
    // 1. splash up first — there is always a window from this point on.
    this.#splash.setStatus("splash", "Starting Rez…");
    await this.#splash.show();

    try {
      // 2. update gate — BEFORE reznet. If an update is applying, the app will
      //    download + relaunch; we stop here and let that happen.
      this.#splash.setStatus("update", "Checking for updates…");
      const gate = await this.#updateGate({
        setStatus: (message) => this.#splash.setStatus("update", message),
      });
      if (gate && gate.applying) {
        this.#splash.setStatus("update", "Updating — Rez will restart…");
        return { stopped: "updating" };
      }

      // 3. preconditions — do we have everything we need before connecting?
      this.#splash.setStatus("preconditions", "Preparing…");
      const problems = await this.#checkPreconditions();
      if (Array.isArray(problems) && problems.length > 0) {
        const message = problems.join("; ");
        this.#logger.error("[bootstrap] precondition failure:", message);
        this.#splash.setStatus("error", message);
        return { stopped: "preconditions", problems };
      }

      // 4. start the backend (node + shell). The relay/reznet connection is
      //    non-blocking inside startBackend and reports its own state.
      this.#splash.setStatus("services", "Starting services…");
      const backend = await this.#startBackend();

      // 5. hand off to the main UI, then retire the splash.
      this.#splash.setStatus("handoff", "Opening…");
      await this.#showMainWindow(backend);
      await this.#splash.close();
      return { ok: true };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.#logger.error("[bootstrap] failed:", message);
      this.#splash.setStatus("error", "Couldn't start Rez: " + message);
      return { stopped: "error", error: message };
    }
  }
}
