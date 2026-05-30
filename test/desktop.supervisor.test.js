import test from "node:test";
import assert from "node:assert/strict";

import { DesktopSupervisor } from "../electron/runtime/DesktopSupervisor.mjs";
import { ChatBridge } from "../src/server/transport/ChatBridge.js";

class FakeVault {
  constructor() {
    this.opened = false;
    this.locked = true;
    this.identity = null;
  }

  open() {
    this.opened = true;
    return this;
  }

  close() {
    this.lock();
    this.opened = false;
  }

  status() {
    return {
      hasAccounts: this.identity != null,
      locked: this.locked,
      activeAccountId: this.identity ? this.identity.accountId : null,
    };
  }

  listAccounts() {
    return this.identity ? [{ id: this.identity.accountId, label: "Account", accountIdHint: this.identity.accountId }] : [];
  }

  async createAccount() {
    this.locked = false;
    this.identity = { accountId: "acct-supervisor", deviceId: "dev-supervisor" };
    return this.getActiveIdentitySummary();
  }

  async unlock() {
    this.locked = false;
    this.identity = { accountId: "acct-supervisor", deviceId: "dev-supervisor" };
    return this.getActiveIdentitySummary();
  }

  lock() {
    this.locked = true;
    return this.status();
  }

  getActiveIdentitySummary() {
    return this.locked ? null : this.identity;
  }
}

// Minimal bus shim that mirrors ChatServerBus surface needed by ChatBridge +
// DesktopBusBridge: registerFunction, call, on, emit.
function createMiniBus() {
  const functions = new Map();
  const listeners = new Map();
  return {
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
  };
}

function createFakeChatApp({ chatServerAccountId = "acct-chat-server" } = {}) {
  const bus = createMiniBus();
  // Stub session service so #chatSessionInfo can resolve the chat-server's
  // identity and inbox. The chat-server's accountId is what BaseServerService
  // stamps as senderAccountId on every outbound message, so the runtime
  // summary must surface it as ownerAccountId.
  bus.services = {
    session: {
      getSessionInfo() {
        return {
          accountId: chatServerAccountId,
          deviceId: "server",
          localInboxId: "inbox-supervisor",
        };
      },
    },
  };
  const chatBridge = new ChatBridge({ bus, ownerAccountId: chatServerAccountId });
  return {
    chatServer: { bus, bridge: chatBridge, ownerAccountId: chatServerAccountId },
    async stop() {},
  };
}

test("supervisor requires unlocked vault before connect", async () => {
  const vault = new FakeVault();
  const supervisor = new DesktopSupervisor({
    vault,
    chatApp: createFakeChatApp(),
    logger: { warn() {} },
  });
  await supervisor.start();
  await assert.rejects(() => supervisor.connect(), /unlocked/i);
  await supervisor.stop();
});

test("supervisor wires bus bridge after connect + tears down on disconnect", async () => {
  const vault = new FakeVault();
  const supervisor = new DesktopSupervisor({
    vault,
    chatApp: createFakeChatApp(),
    logger: { warn() {} },
  });
  await supervisor.start();
  await supervisor.unlock({});
  await supervisor.connect();
  const bridge = supervisor.getBusBridge();
  assert.ok(bridge, "bridge should exist after connect");
  assert.equal(typeof bridge.call, "function");
  assert.equal(typeof bridge.subscribeEvents, "function");

  await supervisor.disconnect();
  assert.throws(() => supervisor.getBusBridge(), /not connected/);
  await supervisor.stop();
});

test("supervisor #runtimeSummary surfaces localInboxId from session service", async () => {
  const vault = new FakeVault();
  const supervisor = new DesktopSupervisor({
    vault,
    chatApp: createFakeChatApp({ chatServerAccountId: "acct-supervisor" }),
    logger: { warn() {} },
  });
  await supervisor.start();
  await supervisor.unlock({});
  const summary = await supervisor.connect();
  assert.equal(summary.connected, true);
  assert.equal(summary.localInboxId, "inbox-supervisor");
  assert.equal(summary.ownerAccountId, "acct-supervisor");
  await supervisor.stop();
});

test("supervisor #runtimeSummary reports chat-server accountId as ownerAccountId, not the vault accountId", async () => {
  // The chat-server bootstraps its own identity (ensureChatServerIdentity)
  // distinct from the vault account. Every outbound message has
  // senderAccountId = chat-server identity, so the UI's isSelfIdentity check
  // breaks unless ownerAccountId in the runtime summary surfaces that
  // identity. Regression: own messages rendered as inbound (left-aligned,
  // no delivered/read dot).
  const vault = new FakeVault();
  const supervisor = new DesktopSupervisor({
    vault,
    chatApp: createFakeChatApp({ chatServerAccountId: "acct-chat-server" }),
    logger: { warn() {} },
  });
  await supervisor.start();
  await supervisor.unlock({});
  const summary = await supervisor.connect();
  assert.equal(summary.connected, true);
  assert.equal(summary.accountId, "acct-supervisor");
  assert.equal(summary.ownerAccountId, "acct-chat-server");
  assert.equal(summary.localInboxId, "inbox-supervisor");
  await supervisor.stop();
});
