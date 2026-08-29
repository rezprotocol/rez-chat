// M7 (plans/MOBILE_LIFECYCLE_ADAPTER_PLAN.md §3/§7f) — the adapter's
// lifecycle GLUE. The primitives are proven in their own slices; what these
// tests pin is the §7f review list: coalescing (one pass + one dirty bit),
// short-circuit without poisoning the next wake, best-effort continuation
// after connectivity, onBackground best-effort/idempotent and unable to
// touch account authority, no hidden durable truth, idempotent repeated
// hooks, and hooks that never throw at the host.

import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { MobileLifecycleAdapter } from "../src/server/runtime/MobileLifecycleAdapter.js";
import { AccountControlChannel } from "../src/server/runtime/AccountControlChannel.js";

const QUIET = { log() {}, warn() {}, info() {}, error() {} };
const ORDER = ["ensureLive", "renewLeaseIfDue", "drain", "commitSweep", "siblingSync"];

// A scripted directive surface: every registered directive records its
// invocation order; behaviors are per-directive overridable (throw / gate).
function makeHarness({ behaviors = {} } = {}) {
  const bus = new ChatServerBus({ config: {}, logger: QUIET });
  const calls = [];
  const register = (ns, name, label) => {
    bus.registerFunction({
      namespace: ns,
      name,
      fn: async () => {
        calls.push(label);
        const behavior = behaviors[label];
        if (typeof behavior === "function") return behavior();
        return { ok: true };
      },
    });
  };
  register("runtime", "ensureLive", "ensureLive");
  register("runtime", "renewLeaseIfDue", "renewLeaseIfDue");
  register("inbox", "drain", "drain");
  register("message.commit", "sweep", "commitSweep");
  register("sibling-sync", "syncAll", "siblingSync");
  return { bus, calls };
}

test("M7 glue: one converge pass runs the five directives in the frozen order", async () => {
  const { bus, calls } = makeHarness();
  const adapter = new MobileLifecycleAdapter({ bus, logger: QUIET });
  const report = await adapter.onForeground();
  assert.deepEqual(calls, ORDER);
  assert.equal(report.live, true);
  assert.deepEqual(report.reasons, ["foreground"]);
  for (const step of Object.values(report.steps)) assert.equal(step.ok, true);
});

test("M7 coalescing (§7f pin 2): a wake storm mid-pass yields EXACTLY one follow-up pass — one dirty bit, never a per-reason queue", async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const { bus, calls } = makeHarness({ behaviors: { ensureLive: () => gate } });
  const adapter = new MobileLifecycleAdapter({ bus, logger: QUIET });

  const first = adapter.onNetworkAvailable();
  // Three more wakes land while pass 1 is stuck inside ensureLive.
  adapter.onPushWake();
  adapter.onForeground();
  adapter.onPeriodicWake();
  release();
  const report = await first;

  assert.equal(calls.filter((c) => c === "ensureLive").length, 2, "pass 1 + exactly ONE rerun — not four");
  assert.deepEqual(calls, [...ORDER, ...ORDER]);
  assert.deepEqual(report.reasons, ["push-wake", "foreground", "periodic-wake"],
    "the follow-up pass carries the accumulated reasons (diagnostics only)");
});

test("M7 short-circuit (§7f pin 1): a failed ensureLive stops THAT pass, throws nothing at the host, and does not poison the next wake", async () => {
  let offline = true;
  const { bus, calls } = makeHarness({
    behaviors: {
      ensureLive: () => {
        if (offline) {
          const err = new Error("UNREACHABLE");
          err.retryable = true;
          throw err;
        }
        return { live: true };
      },
    },
  });
  const adapter = new MobileLifecycleAdapter({ bus, logger: QUIET });

  const report1 = await adapter.onPeriodicWake(); // must not reject
  assert.equal(report1.live, false);
  assert.equal(report1.steps.ensureLive.ok, false);
  assert.deepEqual(calls, ["ensureLive"], "nothing after the gate ran");

  offline = false;
  const report2 = await adapter.onNetworkAvailable();
  assert.equal(report2.live, true);
  assert.deepEqual(calls, ["ensureLive", ...ORDER], "the next wake converges fully — no poisoned state");
});

test("M7 best-effort (§7f pin 1): a mid-sequence failure is recorded and the LATER safe steps still run", async () => {
  const { bus, calls } = makeHarness({
    behaviors: {
      drain: () => { throw new Error("mailbox flaked"); },
    },
  });
  const adapter = new MobileLifecycleAdapter({ bus, logger: QUIET });
  const report = await adapter.onForeground();
  assert.deepEqual(calls, ORDER, "commitSweep + siblingSync ran despite the drain failure");
  assert.equal(report.steps.drain.ok, false);
  assert.equal(report.steps.commitSweep.ok, true);
  assert.equal(report.steps.siblingSync.ok, true);
});

test("M7: a runtime wired without some directives skips them instead of failing (the adapter invents no requirements)", async () => {
  const bus = new ChatServerBus({ config: {}, logger: QUIET });
  const calls = [];
  bus.registerFunction({ namespace: "runtime", name: "ensureLive", fn: async () => { calls.push("ensureLive"); } });
  bus.registerFunction({ namespace: "inbox", name: "drain", fn: async () => { calls.push("drain"); } });
  const adapter = new MobileLifecycleAdapter({ bus, logger: QUIET });
  const report = await adapter.onPushWake();
  assert.deepEqual(calls, ["ensureLive", "drain"]);
  assert.equal(report.steps.renewLeaseIfDue.skipped, true);
  assert.equal(report.steps.commitSweep.skipped, true);
  assert.equal(report.steps.siblingSync.skipped, true);
});

test("M7 onBackground (§7f pin 3): best-effort + idempotent — no closure is a no-op, a failing closure is swallowed with a log, and NO converge runs", async () => {
  const { bus, calls } = makeHarness();

  const bare = new MobileLifecycleAdapter({ bus, logger: QUIET });
  assert.deepEqual(await bare.onBackground(), { suspended: false, reason: "no-account-control" });

  let suspends = 0;
  const failing = new MobileLifecycleAdapter({
    bus,
    suspendAccountControl: async () => {
      suspends += 1;
      if (suspends === 1) throw new Error("teardown hiccup");
      return { suspended: true };
    },
    logger: QUIET,
  });
  const first = await failing.onBackground(); // must not throw
  assert.deepEqual(first, { suspended: false, reason: "suspend-failed" });
  const second = await failing.onBackground();
  assert.deepEqual(second, { suspended: true });
  assert.deepEqual(calls, [], "backgrounding is a stand-down — it never converges");
});

test("M7: AccountControlChannel.suspend() tears the session down WITHOUT killing the channel — foreground control work still runs after resume", async () => {
  let built = 0;
  const clients = [];
  const control = new AccountControlChannel({
    identity: { publicKeyB64: "acct-pub", privateKeyB64: "acct-priv" },
    uplinks: ["ws://node"],
    clientFactory: async () => {
      built += 1;
      const client = {
        connected: true,
        async connect() {},
        async disconnect() { client.connected = false; },
        async stop() {},
      };
      clients.push(client);
      return client;
    },
    logger: QUIET,
  });

  // Idempotent before any session.
  assert.deepEqual(await control.suspend(), { suspended: false, reason: "no-session" });

  await control.execute(async () => "work");
  assert.equal(control.active, true);
  assert.deepEqual(await control.suspend(), { suspended: true });
  assert.equal(control.active, false);
  assert.equal(clients[0].connected, false, "the account session was torn down");

  // NOT terminal: the next foreground control op rebuilds a fresh client.
  const result = await control.execute(async () => "post-resume work");
  assert.equal(result, "post-resume work");
  assert.equal(built, 2);
  assert.equal(control.executeCount, 2);
  await control.close();
});

test("M7 structural (§7f pin 4): the adapter holds no account-control handle — a REAL channel on the bus records ZERO executions across every hook", async () => {
  const { bus } = makeHarness();
  const control = new AccountControlChannel({
    identity: { publicKeyB64: "acct-pub", privateKeyB64: "acct-priv" },
    uplinks: ["ws://node"],
    clientFactory: () => { throw new Error("account session opened from a lifecycle hook — M7 rule violated"); },
    logger: QUIET,
  });
  bus.runtime.accountControl = control;
  const adapter = new MobileLifecycleAdapter({
    bus,
    suspendAccountControl: () => control.suspend(),
    logger: QUIET,
  });

  await adapter.onForeground();
  await adapter.onPushWake();
  await adapter.onNetworkAvailable();
  await adapter.onPeriodicWake();
  await adapter.onBackground();
  await adapter.onForeground();

  assert.equal(control.executeCount, 0, "zero AccountControlChannel executions across the entire lifecycle");
  assert.equal(control.active, false);
});

test("M7: repeated sequential hooks are idempotent — each converge re-derives from the directives, the adapter accumulates no hidden truth", async () => {
  const { bus, calls } = makeHarness();
  const adapter = new MobileLifecycleAdapter({ bus, logger: QUIET });
  await adapter.onForeground();
  await adapter.onForeground();
  await adapter.onPeriodicWake();
  assert.deepEqual(calls, [...ORDER, ...ORDER, ...ORDER], "three identical full passes — nothing cached, nothing skipped");
  assert.deepEqual(adapter.lastReport.reasons, ["periodic-wake"]);
});
