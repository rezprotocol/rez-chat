import test from "node:test";
import assert from "node:assert/strict";

import { DesktopBusBridge } from "../electron/runtime/DesktopBusBridge.mjs";
import {
  ChatBridge,
  CHAT_BRIDGE_SPEC,
} from "../src/server/transport/ChatBridge.js";

function createMiniBus() {
  const functions = new Map();
  const listeners = new Map();
  const bus = {
    registerFunction({ namespace, name, fn }) {
      functions.set(namespace + "." + name, fn);
    },
    async call(namespace, name, payload) {
      const fn = functions.get(namespace + "." + name);
      if (!fn) throw new Error("no function " + namespace + "." + name);
      return fn(payload);
    },
    on(eventName, handler) {
      let set = listeners.get(eventName);
      if (!set) {
        set = new Set();
        listeners.set(eventName, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
    emit(eventName, payload) {
      const set = listeners.get(eventName);
      if (!set) return;
      for (const h of set) h(payload);
    },
    _registeredCount() {
      return functions.size;
    },
    _listenerCount(eventName) {
      const set = listeners.get(eventName);
      return set ? set.size : 0;
    },
  };
  return bus;
}

function buildChatApp({ withChatBridge = true, registerStubDirectives = true } = {}) {
  const bus = createMiniBus();
  if (registerStubDirectives) {
    // Register a stub function for every entry in the bindings table so
    // generic dispatch reaches a callable. The functions echo back their
    // namespace/name + params (wrapped in the result record shape later).
    for (const method of Object.keys(CHAT_BRIDGE_SPEC.methods)) {
      const ns = method.includes(".") ? method.slice(0, method.lastIndexOf(".")) : method;
      const name = method.includes(".") ? method.slice(method.lastIndexOf(".") + 1) : method;
      const { result: ResultCtor } = CHAT_BRIDGE_SPEC.methods[method];
      bus.registerFunction({
        namespace: ns,
        name,
        fn: (params) => {
          // Construct an empty result of the expected shape. Most result records
          // accept {} and fill defaults; if not, the test will surface it.
          try {
            return new ResultCtor({});
          } catch (err) {
            // Some result records require specific fields; tests that exercise
            // these will provide their own bus override.
            return null;
          }
        },
      });
    }
  }
  const chatApp = {
    chatServer: {
      bus,
      ownerAccountId: "acct-bridge-test",
    },
  };
  if (withChatBridge) {
    chatApp.chatServer.bridge = new ChatBridge({ bus, ownerAccountId: "acct-bridge-test" });
  }
  return { chatApp, bus };
}

test("DesktopBusBridge requires a chat app with a bus", () => {
  assert.throws(() => new DesktopBusBridge({ chatApp: null }), /requires chatApp\.chatServer\.bus/);
  assert.throws(() => new DesktopBusBridge({ chatApp: { chatServer: {} } }), /requires chatApp\.chatServer\.bus/);
});

test("DesktopBusBridge.call rejects unknown methods", async () => {
  const { chatApp } = buildChatApp();
  const bridge = new DesktopBusBridge({ chatApp });
  await assert.rejects(() => bridge.call("does.not.exist", {}), /unknown method/);
});

test("DesktopBusBridge.call dispatches a representative directive via bus.call", async () => {
  // We verify the dispatch shape against a representative set spanning multiple
  // namespaces. Exhaustive per-method coverage is the integration test's job
  // — and the architecture guardrail enforces that no per-directive method
  // exists on DesktopRuntimeClient / DesktopSupervisor, so any future
  // directive flows through this same dispatch path automatically.
  const { chatApp, bus } = buildChatApp();
  const seen = [];
  const origCall = bus.call.bind(bus);
  bus.call = async (ns, name, payload) => {
    seen.push({ ns, name });
    return origCall(ns, name, payload);
  };
  const bridge = new DesktopBusBridge({ chatApp });
  const cases = [
    { method: "threads.list", params: { limit: 10 }, ns: "threads", name: "list" },
    { method: "contacts.list", params: {}, ns: "contacts", name: "list" },
    { method: "groups.list", params: {}, ns: "groups", name: "list" },
    { method: "mesh.status", params: {}, ns: "mesh", name: "status" },
    { method: "node.status", params: {}, ns: "node", name: "status" },
    { method: "peer-links.list", params: {}, ns: "peer-links", name: "list" },
    { method: "profile.getOwn", params: {}, ns: "profile", name: "getOwn" },
  ];
  for (const c of cases) {
    await bridge.call(c.method, c.params).catch(() => {});
  }
  for (const c of cases) {
    assert.ok(seen.some((s) => s.ns === c.ns && s.name === c.name),
      "missing dispatch for " + c.method);
  }
});

test("DesktopBusBridge.subscribeEvents wires one bus.on per CHAT_BRIDGE_SPEC.events entry", () => {
  const { chatApp, bus } = buildChatApp();
  const bridge = new DesktopBusBridge({ chatApp });
  bridge.subscribeEvents(() => {});
  for (const eventName of Object.keys(CHAT_BRIDGE_SPEC.events)) {
    assert.equal(bus._listenerCount(eventName), 1, "expected 1 subscriber for " + eventName);
  }
});

test("DesktopBusBridge.subscribeEvents forwards bus.emit envelopes verbatim", () => {
  const { chatApp, bus } = buildChatApp();
  const bridge = new DesktopBusBridge({ chatApp });
  const envelopes = [];
  bridge.subscribeEvents((e) => envelopes.push(e));
  // Pick one event with a simple payload shape.
  const eventName = "message.status";
  bus.emit(eventName, { threadId: "th_1", messageId: "msg-1", status: "sent" });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].event, eventName);
  assert.equal(envelopes[0].payload.threadId, "th_1");
  assert.equal(envelopes[0].payload.messageId, "msg-1");
});

test("DesktopBusBridge.subscribeEvents returns granular unsubscribe (does not cross-cancel)", () => {
  // Regression: returning `() => this.close()` from subscribeEvents caused
  // every concurrent caller (e.g. multiple waitForEvent promises) to lose
  // their subscriptions when ONE called its unsub. Now each call returns a
  // local unsub that only releases its own subscriptions.
  const { chatApp, bus } = buildChatApp();
  const bridge = new DesktopBusBridge({ chatApp });
  const a = [];
  const b = [];
  const offA = bridge.subscribeEvents((envelope) => a.push(envelope));
  const offB = bridge.subscribeEvents((envelope) => b.push(envelope));
  // Each event name now has 2 subscribers (one per subscribeEvents call).
  assert.equal(bus._listenerCount("message.deposited"), 2);
  // Releasing A's subscription must NOT touch B's.
  offA();
  assert.equal(bus._listenerCount("message.deposited"), 1);
  bus.emit("message.deposited", { threadId: "th_x", message: { threadId: "th_x", messageId: "m1" } });
  assert.equal(a.length, 0, "A unsubscribed — should not have received the event");
  assert.equal(b.length, 1, "B should still receive the event");
  offB();
  assert.equal(bus._listenerCount("message.deposited"), 0);
});

test("DesktopBusBridge.close releases all subscriptions", () => {
  const { chatApp, bus } = buildChatApp();
  const bridge = new DesktopBusBridge({ chatApp });
  bridge.subscribeEvents(() => {});
  for (const eventName of Object.keys(CHAT_BRIDGE_SPEC.events)) {
    assert.equal(bus._listenerCount(eventName), 1);
  }
  bridge.close();
  for (const eventName of Object.keys(CHAT_BRIDGE_SPEC.events)) {
    assert.equal(bus._listenerCount(eventName), 0);
  }
});
