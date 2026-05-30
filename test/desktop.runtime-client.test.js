import test from "node:test";
import assert from "node:assert/strict";

import { DesktopRuntimeClient } from "../src/client/runtime/DesktopRuntimeClient.js";
import { CHAT_BRIDGE_METHOD_BINDINGS } from "../src/server/transport/ChatBridge.js";

function createDesktopBridge(calls) {
  const eventHandlers = new Map();
  return {
    runtime: {
      async connect() {
        calls.push({ scope: "runtime", method: "connect", params: {} });
        return { accountId: "acct-1", deviceId: "dev-1", ownerAccountId: "acct-1", localInboxId: "inbox-1" };
      },
      async disconnect() {
        calls.push({ scope: "runtime", method: "disconnect", params: {} });
        return { connected: false };
      },
      async status() {
        return { runtimeConnected: true };
      },
    },
    bus: {
      async call(method, params) {
        calls.push({ scope: "bus", method, params });
        if (method === "thread.messages.list") return { items: [], nextBefore: null };
        return { method, params };
      },
      on(eventName, handler) {
        let set = eventHandlers.get(eventName);
        if (!set) {
          set = new Set();
          eventHandlers.set(eventName, set);
        }
        set.add(handler);
        return () => set.delete(handler);
      },
      _emit(eventName, payload) {
        const set = eventHandlers.get(eventName);
        if (!set) return;
        for (const h of set) h(payload);
      },
    },
  };
}

test("desktop runtime client requires generic bus.call surface", () => {
  assert.throws(() => new DesktopRuntimeClient({ desktop: { runtime: {} } }),
    /rezDesktop\.bus\.call/);
  assert.throws(() => new DesktopRuntimeClient({ desktop: { runtime: {}, bus: {} } }),
    /rezDesktop\.bus\.call/);
});

test("desktop runtime client connects + surfaces session info", async () => {
  const calls = [];
  const client = new DesktopRuntimeClient({ desktop: createDesktopBridge(calls) });
  await client.connect();
  const info = client.getSessionInfo();
  assert.equal(info.localInboxId, "inbox-1");
  assert.equal(info.ownerAccountId, "acct-1");
});

test("desktop runtime client dispatches every CHAT_BRIDGE_METHOD_BINDINGS entry via call()", async () => {
  const calls = [];
  const client = new DesktopRuntimeClient({ desktop: createDesktopBridge(calls) });
  await client.connect();

  const allMethods = Object.keys(CHAT_BRIDGE_METHOD_BINDINGS);
  for (const method of allMethods) {
    await client.call(method, { __probe: method });
  }
  const busCalls = calls.filter((c) => c.scope === "bus");
  assert.equal(busCalls.length, allMethods.length);
  for (const method of allMethods) {
    const hit = busCalls.find((c) => c.method === method);
    assert.ok(hit, "missing dispatch for " + method);
    assert.deepEqual(hit.params, { __probe: method });
  }
});

test("desktop runtime client sendRezPayload adapter routes to message.send", async () => {
  const calls = [];
  const client = new DesktopRuntimeClient({ desktop: createDesktopBridge(calls) });
  await client.connect();
  await client.sendRezPayload({ threadId: "th_1", payload: { text: "hi" }, messageId: "c1" });
  const busCall = calls.find((c) => c.scope === "bus" && c.method === "message.send");
  assert.ok(busCall, "sendRezPayload must route to message.send");
  assert.equal(busCall.params.threadId, "th_1");
  assert.deepEqual(busCall.params.payload, { text: "hi" });
  assert.equal(busCall.params.messageId, "c1");
});

test("desktop runtime client onEvent subscribes via bus.on", async () => {
  const calls = [];
  const bridge = createDesktopBridge(calls);
  const client = new DesktopRuntimeClient({ desktop: bridge });
  await client.connect();
  const seen = [];
  const off = client.onEvent("peer-link.updated", (payload) => seen.push(payload));
  bridge.bus._emit("peer-link.updated", { state: "session_established" });
  bridge.bus._emit("peer-link.updated", { state: "accept_committed" });
  off();
  bridge.bus._emit("peer-link.updated", { state: "after-unsub" });
  assert.deepEqual(seen, [{ state: "session_established" }, { state: "accept_committed" }]);
});

test("desktop runtime client transport stubs are stable", async () => {
  const calls = [];
  const client = new DesktopRuntimeClient({ desktop: createDesktopBridge(calls) });
  await client.connect();
  assert.deepEqual(await client.listInvites(), { body: { items: [] } });
  assert.deepEqual(await client.putKeystore(), { stored: false, localOnly: true });
  assert.equal(await client.fetchKeystore(), null);
  assert.equal(client.getActiveUplink(), "desktop-ipc");
  await assert.rejects(client.backup.enable());
});
