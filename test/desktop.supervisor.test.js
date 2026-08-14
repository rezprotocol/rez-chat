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

  // Required by DesktopSupervisor: a vault without this seam cannot have its auto-lock wired, which
  // is exactly the hole audit #4 found. The constructor refuses one, so every double must offer it.
  setAutoLockHandler(handler) {
    this.autoLockHandler = handler;
  }

  getActiveIdentitySummary() {
    return this.locked ? null : this.identity;
  }

  getChatServerIdentity() {
    if (this.locked) return null;
    return {
      accountId: "acct-chat-server",
      publicKeyB64: "chat-public",
      privateKeyB64: "chat-private",
      hasAdminRoot: true,
      accountIdentityDhKeyPair: { publicKeyB64: "seed-dh-public", privateKeyB64: "seed-dh-private" },
    };
  }

  getActiveDeviceKey() {
    return null;
  }

  async adoptLegacyAccountIdentityDhKeyPair(params) {
    this.adoptedLegacyAccountIdentityDh = params;
    return { adopted: true };
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

test("supervisor enables root-only legacy identity-DH adoption and persists the validated key through the vault", async () => {
  const vault = new FakeVault();
  const bus = createMiniBus();
  bus.services = {
    session: {
      getSessionInfo() {
        return { accountId: "acct-chat-server", deviceId: "server", localInboxId: "inbox-supervisor" };
      },
    },
  };
  const chatBridge = new ChatBridge({ bus, ownerAccountId: "acct-chat-server" });
  let chatServer = null;
  const legacyDh = { publicKeyB64: "legacy-dh-public", privateKeyB64: "legacy-dh-private" };
  const chatApp = {
    get chatServer() { return chatServer; },
    async startChatServer(options) {
      assert.equal(options.allowLegacyAccountIdentityDhAdoption, true);
      assert.equal(typeof options.onLegacyAccountIdentityDhAdopted, "function");
      await options.onLegacyAccountIdentityDhAdopted({
        ownerAccountId: "acct-chat-server",
        accountIdentityDhKeyPair: legacyDh,
      });
      chatServer = { bus, bridge: chatBridge, ownerAccountId: "acct-chat-server" };
    },
    async stopChatServer() { chatServer = null; },
    async stop() {},
  };
  const supervisor = new DesktopSupervisor({ vault, chatApp, logger: { warn() {} } });
  await supervisor.start();
  await supervisor.unlock({});
  const connected = await supervisor.connect();
  assert.equal(connected.connected, true);
  assert.deepEqual(vault.adoptedLegacyAccountIdentityDh, {
    ownerAccountId: "acct-chat-server",
    accountIdentityDhKeyPair: legacyDh,
  });
  await supervisor.stop();
});

// --- S10: linkDevice — the new-device ceremony through the supervisor ------

test("linkDevice runs the injected runner against the local node and provisions the delegated vault row", async () => {
  const vault = new FakeVault();
  const runnerCalls = [];
  const delegatedCalls = [];
  vault.createDelegatedAccount = async (params) => {
    delegatedCalls.push(params);
    vault.locked = false;
    vault.identity = { accountId: "rez:acct:linked", deviceId: "rez:dev:linked" };
    return vault.getActiveIdentitySummary();
  };
  const chatApp = createFakeChatApp();
  chatApp.wsUrl = "ws://127.0.0.1:9999/ws";
  chatApp.chatServer = null; // no live session — link allowed
  chatApp.nodeApp = { runtime: { getIdentity() { return { nodePublicKeyB64: "node-pub" }; } } };
  const delegation = {
    accountSignPublicKeyB64: "B-pub",
    accountDhKeyPair: { publicKeyB64: "dh-pub", privateKeyB64: "dh-priv" },
    deviceKeyPair: { publicKeyB64: "c-pub", privateKeyB64: "c-priv" },
    certChain: [{ certId: "rez:cap:x" }],
    cachedDeviceSet: null,
  };
  const supervisor = new DesktopSupervisor({
    vault,
    chatApp,
    deviceLinkRunner: async (params) => {
      runnerCalls.push(params);
      const linked = { delegation, deviceId: "rez:dev:linked", inboxId: "inbox:" + "ab".repeat(12), fingerprint: "aaaa-bbbb-cccc-dddd-eeee" };
      const persistence = await params.persistDelegation(linked);
      return { ...linked, persistence };
    },
    logger: { warn() {} },
  });
  await supervisor.start();

  const result = await supervisor.linkDevice({ linkCode: "rez:link:v1:code", profileName: "Phone", password: "pw-long-enough" });
  assert.equal(result.accountId, "rez:acct:linked");
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].linkCode, "rez:link:v1:code");
  assert.equal(runnerCalls[0].wsUrl, "ws://127.0.0.1:9999/ws");
  assert.equal(runnerCalls[0].expectedNodePublicKeyB64, "node-pub");
  assert.equal(delegatedCalls.length, 1);
  assert.equal(delegatedCalls[0].profileName, "Phone");
  assert.deepEqual(delegatedCalls[0].deviceKeyPair, delegation.deviceKeyPair, "C goes to the vault separately");
  assert.equal("deviceKeyPair" in delegatedCalls[0].delegationBundle, false, "the bundle param never carries C");
  assert.deepEqual(delegatedCalls[0].delegationBundle.certChain, delegation.certChain);
  await supervisor.stop();
});

test("linkDevice guards: missing code; active chat session refuses", async () => {
  const vault = new FakeVault();
  const chatApp = createFakeChatApp();
  chatApp.wsUrl = "ws://127.0.0.1:9999/ws";
  const supervisor = new DesktopSupervisor({
    vault,
    chatApp,
    deviceLinkRunner: async () => { throw new Error("must not run"); },
    logger: { warn() {} },
  });
  await supervisor.start();
  await assert.rejects(() => supervisor.linkDevice({ linkCode: "" }), /requires linkCode/);
  // createFakeChatApp pre-populates chatServer ⇒ a session is live.
  await assert.rejects(
    () => supervisor.linkDevice({ linkCode: "rez:link:v1:x", profileName: "P", password: "pw" }),
    /log out before linking/,
  );
  await supervisor.stop();
});
