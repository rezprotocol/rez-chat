// The desktop load state machine: a splash is up the entire time, the update
// check runs BEFORE reznet, preconditions are validated BEFORE connecting, and
// every failure path lands on a splash state — never a "no window / spinning"
// hang.

import test from "node:test";
import assert from "node:assert/strict";

import { DesktopBootstrap, BOOT_PHASES } from "../electron/runtime/DesktopBootstrap.mjs";

function makeSplash() {
  const statuses = [];
  return {
    statuses,
    shown: 0,
    closed: 0,
    show() { this.shown += 1; },
    setStatus(phase, message) { statuses.push({ phase, message }); },
    close() { this.closed += 1; },
    phases() { return statuses.map((s) => s.phase); },
  };
}

// A recorder so tests can assert the ORDER backend/update/window ran in.
function makeHarness(overrides = {}) {
  const order = [];
  const splash = makeSplash();
  const deps = {
    splash,
    updateGate: async () => { order.push("update"); return { applying: false }; },
    checkPreconditions: async () => { order.push("preconditions"); return []; },
    startBackend: async () => { order.push("backend"); return { id: "backend" }; },
    showMainWindow: async () => { order.push("mainWindow"); },
    logger: { error: () => {}, warn: () => {}, log: () => {} },
    ...overrides,
  };
  return { order, splash, boot: new DesktopBootstrap(deps), deps };
}

test("happy path: splash up, update→preconditions→backend→window, splash closed", async () => {
  const { order, splash, boot } = makeHarness();
  const result = await boot.run();

  assert.deepEqual(result, { ok: true });
  assert.equal(splash.shown, 1, "splash shown exactly once");
  assert.equal(splash.closed, 1, "splash closed after handoff");
  assert.deepEqual(order, ["update", "preconditions", "backend", "mainWindow"],
    "phases ran in order");
});

test("the update gate runs BEFORE the backend/reznet is started", async () => {
  const { order, boot } = makeHarness();
  await boot.run();
  assert.ok(order.indexOf("update") < order.indexOf("backend"),
    "update check precedes backend start (so a stale client updates before touching reznet)");
  assert.ok(order.indexOf("preconditions") < order.indexOf("backend"),
    "preconditions are validated before connecting");
});

test("when an update is applying, the backend is NOT started (app will relaunch)", async () => {
  const { order, splash, boot } = makeHarness({
    updateGate: async () => { order.push("update"); return { applying: true }; },
  });
  const result = await boot.run();

  assert.deepEqual(result, { stopped: "updating" });
  assert.ok(!order.includes("backend"), "backend never starts when an update is applying");
  assert.ok(!order.includes("mainWindow"), "main window not shown while updating");
  assert.equal(splash.statuses.at(-1).phase, "update");
});

test("precondition failure shows an error state and does NOT connect", async () => {
  const { order, splash, boot } = makeHarness({
    checkPreconditions: async () => { order.push("preconditions"); return ["UI bundle missing", "no relays configured"]; },
  });
  const result = await boot.run();

  assert.equal(result.stopped, "preconditions");
  assert.deepEqual(result.problems, ["UI bundle missing", "no relays configured"]);
  assert.ok(!order.includes("backend"), "backend never starts on a precondition failure");
  const last = splash.statuses.at(-1);
  assert.equal(last.phase, "error");
  assert.match(last.message, /UI bundle missing; no relays configured/);
});

test("a backend failure lands on the splash as an error — never a silent hang", async () => {
  const { splash, boot } = makeHarness({
    startBackend: async () => { throw new Error("port in use"); },
  });
  const result = await boot.run();

  assert.equal(result.stopped, "error");
  assert.match(result.error, /port in use/);
  const last = splash.statuses.at(-1);
  assert.equal(last.phase, "error", "the splash shows an error, not nothing");
  assert.match(last.message, /Couldn't start Rez: port in use/);
  assert.equal(splash.closed, 0, "splash stays up showing the error (not closed into a blank screen)");
});

test("the splash is shown before any other phase runs", async () => {
  let shownAt = -1;
  let firstBackendAt = Infinity;
  let n = 0;
  const splash = makeSplash();
  splash.show = function () { this.shown += 1; shownAt = n++; };
  const boot = new DesktopBootstrap({
    splash,
    updateGate: async () => { n++; return { applying: false }; },
    checkPreconditions: async () => { n++; return []; },
    startBackend: async () => { firstBackendAt = n++; return {}; },
    showMainWindow: async () => { n++; },
    logger: { error: () => {} },
  });
  await boot.run();
  assert.equal(shownAt, 0, "splash.show() is the very first thing");
  assert.ok(shownAt < firstBackendAt);
});

test("BOOT_PHASES documents the phase order", () => {
  assert.deepEqual(BOOT_PHASES, ["splash", "update", "preconditions", "services", "handoff"]);
});

test("constructor rejects missing deps", () => {
  assert.throws(() => new DesktopBootstrap({}), /requires splash/);
  const fns = {
    updateGate: async () => ({}),
    checkPreconditions: async () => [],
    startBackend: async () => ({}),
    showMainWindow: async () => {},
  };
  assert.throws(() => new DesktopBootstrap({ ...fns, splash: {} }), /splash must implement/);
});
