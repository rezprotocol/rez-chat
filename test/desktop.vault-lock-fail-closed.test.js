import test from "node:test";
import assert from "node:assert/strict";
import { DesktopSupervisor } from "../src/desktop/runtime/DesktopSupervisor.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopVaultService } from "../src/desktop/runtime/DesktopVaultService.js";

// AUDIT #4 — vault lock / auto-lock must fail CLOSED over the chat runtime.
//
// Locking used to mean `vault.lock()` and nothing else. That zeroes the vault's own copy of the
// keys — and leaves the chat-server running: still connected to the node, still holding its own
// identity, still sending and receiving. "Locked" was a UI state, not a security boundary.
//
// Auto-lock was worse. The vault supported an `onAutoLock` callback that NOTHING anywhere passed,
// so every idle/absolute timeout locked the vault and notified nobody — the case designed for
// walked-away-from-the-machine was the one that left the session fully live.

/** A chat app whose chatServer getter reflects whether stopChatServer actually ran. */
function makeChatApp({ stopThrows = null, stopSilentlyFails = false, terminalStopThrows = null } = {}) {
  const app = {
    stops: 0,
    terminalStops: 0,
    _server: { id: "chat-server" },
    get chatServer() { return app._server; },
    async stopChatServer() {
      app.stops += 1;
      if (stopThrows) throw stopThrows;
      // `stopSilentlyFails` models the real index.js behavior: stopChatServer catches and logs a
      // failing chatServer.stop(), so a failed teardown can return normally.
      if (!stopSilentlyFails) app._server = null;
    },
    // The TERMINAL escalation: full chat-app teardown (node + shell).
    async stop() {
      app.terminalStops += 1;
      if (terminalStopThrows) throw terminalStopThrows;
      app._server = null;
    },
  };
  return app;
}

function makeLogger() {
  const errors = [];
  return { logger: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) }, errors };
}

class FakeVault {
  constructor() {
    this.locked = true;
    this.locks = 0;
    this.autoLockHandler = null;
  }
  open() { return this; }
  close() { this.lock(); }
  status() { return { hasAccounts: true, locked: this.locked, activeAccountId: this.locked ? null : "acct" }; }
  lock() { this.locks += 1; this.locked = true; return this.status(); }
  unlock() { this.locked = false; return this.status(); }
  getActiveIdentitySummary() { return this.locked ? null : { accountId: "acct", deviceId: "dev" }; }
  setAutoLockHandler(fn) { this.autoLockHandler = fn; }
}

function makeSupervisor(opts = {}) {
  const vault = new FakeVault();
  const chatApp = makeChatApp(opts);
  const { logger, errors } = makeLogger();
  const supervisor = new DesktopSupervisor({ vault, chatApp, logger });
  return { supervisor, vault, chatApp, errors };
}

test("lock() tears the chat runtime down, not just the vault", async () => {
  const { supervisor, vault, chatApp } = makeSupervisor();
  vault.unlock();

  const result = await supervisor.lock();

  assert.equal(chatApp.stops, 1, "the chat-server was stopped");
  assert.equal(chatApp.chatServer, null, "and is no longer attached");
  assert.equal(vault.locked, true, "the vault is locked");
  assert.equal(result.runtimeStopped, true);
  assert.equal(supervisor.status().runtimeConnected, false);
});

test("a graceful teardown that THROWS escalates to a terminal shutdown", async () => {
  // Zeroization still happens (the `finally`), and the runtime is brought down the hard way rather
  // than left live. A locked vault beside a running session is the original failure; reporting it
  // accurately is not the same as fixing it.
  const { supervisor, vault, chatApp, errors } = makeSupervisor({ stopThrows: new Error("stop exploded") });
  vault.unlock();

  const result = await supervisor.lock();

  assert.equal(vault.locked, true, "locked despite the failure");
  assert.equal(chatApp.terminalStops, 1, "escalated to a full chat-app shutdown");
  assert.equal(result.runtimeStopped, true, "and the runtime really is down");
  assert.equal(result.escalated, true, "reported as escalated, not as a clean lock");
  assert.ok(errors.some((m) => m.includes("forcing a terminal shutdown")));
  assert.equal(supervisor.status().lockIncomplete, false);
});

test("a teardown that FAILS SILENTLY is caught by the post-condition and escalated", async () => {
  // chatApp.stopChatServer() logs and swallows a failing chatServer.stop(), so a broken teardown
  // returns normally. Trusting the call would leave a live session behind a "successful" lock.
  const { supervisor, vault, chatApp } = makeSupervisor({ stopSilentlyFails: true });
  vault.unlock();

  const result = await supervisor.lock();

  assert.equal(chatApp.terminalStops, 1);
  assert.equal(result.runtimeStopped, true);
  assert.equal(result.escalated, true);
});

test("lock() THROWS LOCK_INCOMPLETE when even the terminal shutdown fails", async () => {
  // The requirement in full: an incomplete lock must not be presentable as success. The IPC layer
  // turns a throw into { ok: false, error: { code } } and the UI's unwrap() rethrows it, so no
  // path can read this as a lock.
  const { supervisor, vault, errors } = makeSupervisor({
    stopSilentlyFails: true,
    terminalStopThrows: new Error("terminal stop exploded"),
  });
  vault.unlock();

  await assert.rejects(
    () => supervisor.lock(),
    (err) => {
      assert.equal(err.code, "LOCK_INCOMPLETE");
      return true;
    },
  );

  assert.equal(vault.locked, true, "the vault is still locked — zeroization is unconditional");
  assert.equal(supervisor.status().lockIncomplete, true, "and the unsafe state is OBSERVABLE, not just logged");
  assert.ok(errors.some((m) => m.includes("LOCK INCOMPLETE")));
});

test("a successful lock CLEARS a previously-recorded incomplete state", async () => {
  const { supervisor, vault, chatApp } = makeSupervisor({
    stopSilentlyFails: true,
    terminalStopThrows: new Error("terminal stop exploded"),
  });
  vault.unlock();
  await assert.rejects(() => supervisor.lock(), /could not be stopped/);
  assert.equal(supervisor.status().lockIncomplete, true);

  // The runtime recovers; the next lock succeeds and the sticky flag clears.
  chatApp._server = null;
  const result = await supervisor.lock();
  assert.equal(result.runtimeStopped, true);
  assert.equal(supervisor.status().lockIncomplete, false);
});

test("the supervisor constructor ALWAYS registers the auto-lock handler", async () => {
  // The previous wiring was a constructor option with no caller anywhere. Registering here makes
  // "an auto-lock tears down the runtime" intrinsic to having a supervisor, not optional wiring.
  const { supervisor, vault, chatApp } = makeSupervisor();
  void supervisor;
  vault.unlock();
  assert.equal(typeof vault.autoLockHandler, "function", "registered without anyone asking");

  await vault.autoLockHandler("idle_timeout");

  assert.equal(chatApp.stops, 1, "an auto-lock tears the runtime down too");
  assert.equal(chatApp.chatServer, null);
});

test("a vault WITHOUT the auto-lock seam cannot build a supervisor at all", () => {
  // Making it required is what stops the original bug recurring: the hook existed and nothing wired
  // it, which no test could catch as long as wiring was optional.
  class SeamlessVault extends FakeVault { }
  const v = new SeamlessVault();
  v.setAutoLockHandler = undefined;
  assert.throws(
    () => new DesktopSupervisor({ vault: v, chatApp: makeChatApp(), logger: makeLogger().logger }),
    /requires a vault exposing setAutoLockHandler/,
  );
});

test("auto-lock ESCALATES too — a failed teardown is not just logged", async () => {
  // Nobody is awaiting an auto-lock, so there is no caller to retry and no error for a user to see.
  // The escalation has to be self-contained.
  const { supervisor, vault, chatApp } = makeSupervisor({ stopThrows: new Error("stop exploded") });
  void supervisor;
  vault.unlock();

  await vault.autoLockHandler("absolute_timeout");

  assert.equal(chatApp.terminalStops, 1, "terminal shutdown ran without anyone asking");
  assert.equal(chatApp.chatServer, null);
});

test("auto-lock records an unsafe state when every escalation fails (it cannot throw)", async () => {
  const { supervisor, vault, errors } = makeSupervisor({
    stopSilentlyFails: true,
    terminalStopThrows: new Error("terminal stop exploded"),
  });
  vault.unlock();

  // Must NOT reject — there is no caller to catch it, and an unhandled rejection would be worse
  // than a recorded state.
  await vault.autoLockHandler("idle_timeout");

  assert.equal(supervisor.status().lockIncomplete, true, "observable via status()");
  assert.ok(errors.some((m) => m.includes("LOCK INCOMPLETE")));
  assert.ok(errors.some((m) => m.includes("auto-lock (idle_timeout)")));
});

// ── THE VAULT'S OWN TIMER PATH ─────────────────────────────────────────────────────────────────
// Driven through a REAL createAccount (which leaves the vault unlocked and arms the timers), with a
// tiny idle timeout. No test-only backdoor: this is exactly the path a walked-away user hits, and
// it had no coverage at all before — the timers existed and nothing ever asserted they fire.

function tmpPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rez-vault-failclosed-"));
  return path.join(dir, name);
}

async function unlockedVault({ idleTimeoutMs = 25 } = {}) {
  const vault = new DesktopVaultService({
    dbPath: tmpPath("vault.sqlite"),
    idleTimeoutMs,
    absoluteTimeoutMs: 600_000,
  }).open();
  await vault.createAccount({ profileName: "Ada", password: "correct horse battery staple" });
  assert.equal(vault.status().locked, false, "created accounts start unlocked with timers armed");
  return vault;
}

function captureConsoleError() {
  const errors = [];
  const real = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  return { errors, restore: () => { console.error = real; } };
}

test("the vault's IDLE timer locks it and invokes the registered handler", async () => {
  const vault = await unlockedVault({ idleTimeoutMs: 25 });
  const seen = [];
  vault.setAutoLockHandler(async (reason) => { seen.push(reason); });

  await new Promise((r) => setTimeout(r, 80));

  assert.deepEqual(seen, ["idle_timeout"]);
  assert.equal(vault.status().locked, true, "and the vault locked itself");
  vault.close();
});

test("an auto-lock with NO handler registered is a LOUD misconfiguration", async () => {
  // Locking the vault zeroes its keys and nothing else. If nobody is listening, the chat runtime
  // keeps running — so a missing handler must never look like a working auto-lock. This is the
  // exact state the code shipped in.
  const vault = await unlockedVault({ idleTimeoutMs: 25 });
  const cap = captureConsoleError();
  try {
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    cap.restore();
  }

  assert.equal(vault.status().locked, true);
  assert.ok(cap.errors.some((m) => m.includes("NO handler registered")), cap.errors.join("|"));
  vault.close();
});

test("a rejecting auto-lock handler is logged, not left as an unhandled rejection", async () => {
  const vault = await unlockedVault({ idleTimeoutMs: 25 });
  vault.setAutoLockHandler(async () => { throw new Error("teardown blew up"); });
  const cap = captureConsoleError();
  try {
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    cap.restore();
  }

  assert.ok(cap.errors.some((m) => m.includes("handler FAILED")), cap.errors.join("|"));
  vault.close();
});

test("setAutoLockHandler is ONE-TIME — a safety hook must not be replaceable", async () => {
  // A replaceable hook can be replaced with something weaker, or cleared entirely, by any code that
  // runs later — and the failure would be invisible, because a vault with a silently-disabled
  // handler looks exactly like a working one.
  const vault = await unlockedVault({ idleTimeoutMs: 60_000 });
  vault.setAutoLockHandler(() => {});
  assert.throws(() => vault.setAutoLockHandler(() => {}), /one-time by design/);
  assert.throws(() => vault.setAutoLockHandler(null), /requires a function/);
  vault.close();
});
