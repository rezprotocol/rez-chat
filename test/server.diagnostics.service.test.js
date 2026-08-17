import test from "node:test";
import assert from "node:assert/strict";

import { ServerDiagnosticsService } from "../src/server/services/ServerDiagnosticsService.js";

const OWNER = "rez:acct:diag-owner";
const ACCOUNT = "rez:acct:uasw5pxai7xpnppznl35ni6336acvrgttydunrc3owrggdp4ggiq";

function makeService({ stores = {}, sdk = null, appVersion = "0.6.0-test" } = {}) {
  const handlers = new Map();
  let now = 1_000;
  const bus = {
    on(name, fn) { handlers.set(name, fn); },
    emit() {},
    registerFunction() {},
    stores,
    runtime: { sdk },
  };
  const logged = [];
  const logger = {
    log() {}, info() {}, debug() {},
    warn(...a) { logged.push(a.map(String).join(" ")); },
    error(...a) { logged.push(a.map(String).join(" ")); },
  };
  const svc = new ServerDiagnosticsService({
    bus, ownerAccountId: OWNER, appVersion, clock: () => now, logger,
  });
  return { svc, handlers, logged, tick: (ms) => { now += ms; } };
}

test("subscribes to app.error on start", async () => {
  const { svc, handlers } = makeService();
  await svc.start();
  assert.ok(handlers.has("app.error"));
});

test("a snapshot carries versions, counts and capabilities — never rows", async () => {
  const { svc } = makeService({
    stores: {
      contactStore: { listAll: async () => [{ a: 1 }, { a: 2 }, { a: 3 }] },
      groupStore: { listGroups: async () => [{ g: 1 }] },
    },
    sdk: {
      getSessionInfo: () => ({
        capabilities: { durableInbox: true, multiDeviceFanout: false, delegatedDevices: true },
      }),
    },
  });
  const snap = await svc.snapshot();

  assert.equal(snap.kind, "rez.chat.diagnostics.v1");
  assert.equal(snap.app.version, "0.6.0-test");
  assert.deepEqual(snap.counts, { contacts: 3, groups: 1 });
  assert.deepEqual(snap.capabilities, {
    durableInbox: true, multiDeviceFanout: false, delegatedDevices: true,
  });
  // The rows themselves must never appear — only how many there were.
  assert.ok(!JSON.stringify(snap).includes("\"a\":1"));
});

test("capabilities read strictly true, so an older node cannot look capable", async () => {
  const { svc } = makeService({
    sdk: { getSessionInfo: () => ({ capabilities: { durableInbox: "yes", delegatedDevices: 1 } }) },
  });
  const snap = await svc.snapshot();
  assert.equal(snap.capabilities.durableInbox, false);
  assert.equal(snap.capabilities.delegatedDevices, false);
});

test("recorded errors are redacted AT CAPTURE", async () => {
  const { svc } = makeService();
  svc.recordError({
    source: "ServerMessagesService",
    severity: "warn",
    message: "send failed to " + ACCOUNT + " in thread:9f2c1d4e5a6b7c8d",
    err: new Error("boom for " + ACCOUNT),
  });
  const snap = await svc.snapshot();
  const asText = JSON.stringify(snap);

  assert.equal(snap.recentErrors.length, 1);
  assert.equal(snap.recentErrors[0].source, "ServerMessagesService");
  assert.ok(!asText.includes("5pxai7xpnppznl35"), "the account body must never reach the buffer");
  assert.ok(!asText.includes("1d4e5a6b7c8d"));
  assert.ok(asText.includes("<redacted>"));
});

test("the buffer holds a redacted COPY, not a reference to the caller's event", async () => {
  // Observable form of "redaction happens at capture, not at export": mutate
  // the original event afterwards. If the service kept a reference and redacted
  // only on the way out, the mutation would surface in the bundle — and any
  // future export path would have to remember to redact all over again.
  const { svc } = makeService();
  const event = { source: "svc", message: "peer " + ACCOUNT };
  svc.recordError(event);
  event.message = "MUTATED AFTER CAPTURE";
  event.source = "MUTATED";

  const snap = await svc.snapshot();
  assert.ok(!JSON.stringify(snap).includes("MUTATED"), "the bundle must not track later mutation");
  assert.ok(!snap.recentErrors[0].message.includes("5pxai7xpnppznl35"), "and was redacted on the way in");
});

test("content-bearing fields never enter the buffer", async () => {
  const { svc } = makeService();
  svc.recordError({ source: "x", message: "failed", err: { text: "the message body", code: "E" } });
  const snap = await svc.snapshot();
  const asText = JSON.stringify(snap);
  assert.ok(!asText.includes("the message body"));
  assert.ok(asText.includes("\"code\":\"E\""), "non-sensitive error fields stay useful");
});

test("the buffer is bounded and reports what it dropped", async () => {
  const { svc } = makeService();
  for (let i = 0; i < 150; i++) svc.recordError({ message: "err " + i });
  const snap = await svc.snapshot();
  assert.equal(snap.recentErrors.length, 100);
  assert.equal(snap.recentErrorsDropped, 50, "silent truncation would read as 'only 100 errors happened'");
  // Oldest dropped, newest kept.
  assert.ok(snap.recentErrors[99].message.includes("149"));
});

test("recordError never throws — it runs on top of someone else's failure", async () => {
  const { svc, logged } = makeService();
  const hostile = {};
  Object.defineProperty(hostile, "message", { get() { throw new Error("nope"); } });
  assert.doesNotThrow(() => svc.recordError(hostile));
  assert.ok(logged.some((l) => l.includes("failed to record")), "but it must not be silent either");
});

test("a store that throws yields a null count, not a failed bundle", async () => {
  const { svc, logged } = makeService({
    stores: {
      contactStore: { listAll: async () => { throw new Error("db gone"); } },
      groupStore: { listGroups: async () => [{ g: 1 }] },
    },
  });
  const snap = await svc.snapshot();
  assert.equal(snap.counts.contacts, null);
  assert.equal(snap.counts.groups, 1, "one broken section must not cost the rest");
  assert.ok(logged.some((l) => l.includes("count failed")));
});

test("a capabilities probe that throws is reported, not swallowed", async () => {
  const { svc } = makeService({
    sdk: { getSessionInfo: () => { throw new Error("no session for " + ACCOUNT); } },
  });
  const snap = await svc.snapshot();
  assert.ok(snap.capabilities.unavailable, "the failure is visible in the bundle");
  assert.ok(!JSON.stringify(snap).includes("5pxai7xpnppznl35"), "and still redacted");
});

test("no sdk yields null capabilities rather than throwing", async () => {
  const { svc } = makeService({ sdk: null });
  const snap = await svc.snapshot();
  assert.equal(snap.capabilities, null);
});

test("uptime advances with the clock", async () => {
  const { svc, tick } = makeService();
  tick(5_000);
  const snap = await svc.snapshot();
  assert.equal(snap.app.uptimeMs, 5_000);
});
