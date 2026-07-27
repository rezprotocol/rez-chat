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
function makeChatApp({ stopThrows = null, stopSilentlyFails = false } = {}) {
  const app = {
    stops: 0,
    _server: { id: "chat-server" },
    get chatServer() { return app._server; },
    async stopChatServer() {
      app.stops += 1;
      if (stopThrows) throw stopThrows;
      // `stopSilentlyFails` models the real index.js behavior: stopChatServer catches and logs a
      // failing chatServer.stop(), so a failed teardown can return normally.
      if (!stopSilentlyFails) app._server = null;
    },
    async stop() { app._server = null; },
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

test("lock() STILL locks the vault when the runtime teardown throws", async () => {
  // Zeroization is the one thing we can always do. Skipping it because something else failed would
  // be strictly worse than a partial lock.
  const { supervisor, vault, errors } = makeSupervisor({ stopThrows: new Error("stop exploded") });
  vault.unlock();

  const result = await supervisor.lock();

  assert.equal(vault.locked, true, "locked despite the failure");
  assert.equal(result.runtimeStopped, false, "and honestly reports that the runtime is not down");
  assert.ok(errors.some((m) => m.includes("the vault is LOCKED but the chat runtime was not")));
});

test("lock() detects a teardown that FAILED SILENTLY", async () => {
  // chatApp.stopChatServer() logs and swallows a failing chatServer.stop(), so a broken teardown
  // returns normally. Trusting the call would report a clean lock over a live session — so the
  // post-condition is checked against the same signal status() reports.
  const { supervisor, vault, chatApp, errors } = makeSupervisor({ stopSilentlyFails: true });
  vault.unlock();

  const result = await supervisor.lock();

  assert.equal(chatApp.chatServer !== null, true, "the server really is still attached");
  assert.equal(vault.locked, true);
  assert.equal(result.runtimeStopped, false, "not reported as a clean lock");
  assert.ok(errors.some((m) => m.includes("still be live")));
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

test("an auto-lock whose teardown fails is reported, never silent", async () => {
  const { supervisor, vault, errors } = makeSupervisor({ stopThrows: new Error("stop exploded") });
  void supervisor;
  vault.unlock();

  await vault.autoLockHandler("absolute_timeout");

  assert.ok(errors.some((m) => m.includes("auto-lock (absolute_timeout)")));
  assert.ok(errors.some((m) => m.includes("may still be live")));
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
