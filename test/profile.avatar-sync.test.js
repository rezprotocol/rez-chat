import { installFakeDom, FakeElement } from "./_helpers/fakeDom.js";
import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { ConnectionStore } from "../src/ui/stores/ConnectionStore.js";
import { OwnAvatarView } from "../src/ui/views/OwnAvatarView.js";
import { SettingsTabView } from "../src/ui/views/SettingsTabView.js";
import { MessageQueries } from "../src/ui/queries/MessageQueries.js";
import { ContactQueries } from "../src/ui/queries/ContactQueries.js";
import test from "node:test";
import assert from "node:assert/strict";

import { SessionService } from "../src/ui/services/bus/SessionService.js";
import { SessionStore, SESSION_STATUS } from "../src/ui/stores/SessionStore.js";
import { ChatBus } from "../src/ui/root/ChatBus.js";

const ACCOUNT_ID = "acct_owner";
const STORED_HASH = "deadbeef1234567890";
const STORED_AVATAR_B64 = "AAAA";

function makeFakeAuthBootstrap({ initialHash = "", initialData = "" } = {}) {
  let hash = initialHash;
  let data = initialData;
  return {
    async init() {},
    async getAvatarFileHash() { return hash; },
    async getAvatarDataB64() { return data; },
    async setAvatarFileHash(_acct, value) { hash = String(value || ""); },
    async setAvatarDataB64(_acct, value) { data = String(value || ""); },
    inspect() { return { hash, data }; },
  };
}

function makeSessionService({ bootstrap, client }) {
  const bus = new ChatBus({});
  const sessionStore = new SessionStore({ bus });
  bus.stores.session = sessionStore;
  bus.runtime = { client };
  sessionStore.setUnlocked({ accountId: ACCOUNT_ID, deviceId: "dev_test" });
  // Ensure status reflects UNLOCKED for the resolver path.
  assert.equal(sessionStore.snapshot().status, SESSION_STATUS.UNLOCKED);
  const service = new SessionService({
    bus,
    authBootstrapService: bootstrap,
    accountAuthService: { unlock() {}, unlockWithDevice() {}, disableDeviceUnlock() {}, createAccount() {}, logout() {} },
    sessionStore,
    logger: { warn() {}, error() {}, info() {} },
  });
  return { service, bus, sessionStore };
}

test("avatar sync leaves local avatar intact when server reports empty hash (cold-start race)", async () => {
  const bootstrap = makeFakeAuthBootstrap({
    initialHash: STORED_HASH,
    initialData: STORED_AVATAR_B64,
  });
  const calls = [];
  const client = {
    async call(method) {
      calls.push(method);
      if (method === "profile.getOwn") {
        // Server hasn't loaded profile meta yet → reports empty hash.
        return { avatarFileHash: "" };
      }
      throw new Error("unexpected call: " + method);
    },
  };

  let avatarChangedEmits = 0;
  const { service, bus } = makeSessionService({ bootstrap, client });
  bus.on("session.avatarChanged", () => { avatarChangedEmits += 1; });

  await service._syncAvatarFromServer();

  const after = bootstrap.inspect();
  assert.equal(after.hash, STORED_HASH, "local hash must be preserved");
  assert.equal(after.data, STORED_AVATAR_B64, "local avatar bytes must be preserved");
  assert.equal(avatarChangedEmits, 0, "no avatarChanged emit when nothing changed");
  assert.deepEqual(calls, ["profile.getOwn"], "no file fetch should occur");
});

test("avatar sync no-ops when local and server hashes already match", async () => {
  const bootstrap = makeFakeAuthBootstrap({
    initialHash: STORED_HASH,
    initialData: STORED_AVATAR_B64,
  });
  const calls = [];
  const client = {
    async call(method) {
      calls.push(method);
      if (method === "profile.getOwn") return { avatarFileHash: STORED_HASH };
      throw new Error("unexpected call: " + method);
    },
  };

  const { service } = makeSessionService({ bootstrap, client });
  await service._syncAvatarFromServer();

  const after = bootstrap.inspect();
  assert.equal(after.hash, STORED_HASH);
  assert.equal(after.data, STORED_AVATAR_B64);
  assert.deepEqual(calls, ["profile.getOwn"], "matching hashes should skip file fetch");
});

test("avatar sync writes hash and data atomically when server reports a new hash", async () => {
  const NEW_HASH = "cafebabe7777";
  const NEW_DATA = "BBBB";
  const bootstrap = makeFakeAuthBootstrap({
    initialHash: STORED_HASH,
    initialData: STORED_AVATAR_B64,
  });
  const client = {
    async call(method, params) {
      if (method === "profile.getOwn") return { avatarFileHash: NEW_HASH };
      if (method === "file.get") {
        assert.equal(params.fileHashHex, NEW_HASH);
        return { fileDataB64: NEW_DATA };
      }
      throw new Error("unexpected call: " + method);
    },
  };

  const { service } = makeSessionService({ bootstrap, client });
  await service._syncAvatarFromServer();

  const after = bootstrap.inspect();
  assert.equal(after.hash, NEW_HASH);
  assert.equal(after.data, NEW_DATA);
});

test("avatar sync does NOT touch local hash when file download fails (no hash/data drift)", async () => {
  const NEW_HASH = "cafebabe7777";
  const bootstrap = makeFakeAuthBootstrap({
    initialHash: STORED_HASH,
    initialData: STORED_AVATAR_B64,
  });
  const client = {
    async call(method) {
      if (method === "profile.getOwn") return { avatarFileHash: NEW_HASH };
      if (method === "file.get") throw new Error("network down");
      throw new Error("unexpected call: " + method);
    },
  };

  const { service } = makeSessionService({ bootstrap, client });
  await service._syncAvatarFromServer();

  const after = bootstrap.inspect();
  assert.equal(after.hash, STORED_HASH, "local hash unchanged on failed file fetch");
  assert.equal(after.data, STORED_AVATAR_B64, "local data unchanged on failed file fetch");
});

test("browser lock refuses to clear auth when its runtime cannot stop", async () => {
  const bus = new ChatBus({});
  const sessionStore = new SessionStore({ bus });
  bus.stores.session = sessionStore;
  sessionStore.setUnlocked({ accountId: ACCOUNT_ID, deviceId: "dev_browser" });
  bus.registerFunction({
    namespace: "runtime",
    name: "disconnect",
    fn: async () => { throw new Error("stop failed"); },
  });
  let logouts = 0;
  const accountAuthService = {
    runtimeDisconnectMustSucceed() { return true; },
    async logout() { logouts += 1; },
  };
  const service = new SessionService({
    bus,
    authBootstrapService: { async init() {} },
    accountAuthService,
    sessionStore,
    logger: { warn() {}, error() {}, info() {} },
  });

  await assert.rejects(
    () => service.lock(),
    (err) => err.code === "RUNTIME_DISCONNECT_FAILED",
  );
  assert.equal(logouts, 0);
  assert.equal(sessionStore.snapshot().status, SESSION_STATUS.UNLOCKED);
});

test("desktop lock still delegates teardown escalation to the vault supervisor", async () => {
  const bus = new ChatBus({});
  const sessionStore = new SessionStore({ bus });
  bus.stores.session = sessionStore;
  sessionStore.setUnlocked({ accountId: ACCOUNT_ID, deviceId: "dev_desktop" });
  bus.registerFunction({
    namespace: "runtime",
    name: "disconnect",
    fn: async () => { throw new Error("pre-step failed"); },
  });
  let logouts = 0;
  const accountAuthService = {
    runtimeDisconnectMustSucceed() { return false; },
    async logout() {
      logouts += 1;
      sessionStore.setLocked({});
    },
  };
  const service = new SessionService({
    bus,
    authBootstrapService: { async init() {} },
    accountAuthService,
    sessionStore,
    logger: { warn() {}, error() {}, info() {} },
  });

  await service.lock();
  assert.equal(logouts, 1);
  assert.equal(sessionStore.snapshot().status, SESSION_STATUS.LOCKED);
});

test("avatar sync does NOT touch local when file fetch returns empty bytes", async () => {
  const NEW_HASH = "cafebabe7777";
  const bootstrap = makeFakeAuthBootstrap({
    initialHash: STORED_HASH,
    initialData: STORED_AVATAR_B64,
  });
  const client = {
    async call(method) {
      if (method === "profile.getOwn") return { avatarFileHash: NEW_HASH };
      if (method === "file.get") return { fileDataB64: "" };
      throw new Error("unexpected call: " + method);
    },
  };

  const { service } = makeSessionService({ bootstrap, client });
  await service._syncAvatarFromServer();

  const after = bootstrap.inspect();
  assert.equal(after.hash, STORED_HASH);
  assert.equal(after.data, STORED_AVATAR_B64);
});

// Hosted human-QA regressions (2026-11-11).
const settle = () => new Promise((resolve) => setImmediate(resolve));
const text = (node) => node.textContent || node.children.map(text).join(" ");
const images = (node) => [node, ...node.children.flatMap(images)].filter((child) => child.tagName === "IMG");

test("saved sibling accounts do not get self labels or own-message actions", () => {
  const session = new SessionStore({ bus: null });
  session.setAccountList([{ id: "a", accountIdHint: "account:alice" }, { id: "b", accountIdHint: "account:bob" }]);
  session.setUnlocked({ accountId: "b", ownerAccountId: "account:bob", deviceId: "b1" });
  const stores = {
    session, contacts: { getContact: () => null },
    messages: { getMessage: () => ({ speakerId: "account:alice", senderAccountId: "account:alice" }) },
  };
  assert.equal(new MessageQueries({ stores }).isOwnMessage("thread", "incoming"), false);
  assert.notEqual(new ContactQueries({ stores }).displayName("account:alice"), "You");
  assert.equal(new ContactQueries({ stores }).displayName("account:bob"), "You");
});

test("own avatar follows identity after mount and ignores superseded fetches", async () => {
  installFakeDom();
  const bus = new ChatServerBus();
  bus.stores.session = new SessionStore({ bus: null });
  const requests = [];
  bus.registerFunction({ namespace: "session", name: "getOwnAvatar", fn: (params) => new Promise((resolve) => requests.push({ params, resolve })) });
  const root = new FakeElement();
  const view = new OwnAvatarView({ bus, accountId: "", label: "Account" });
  view.mount(root);
  view.setAccount("avatar-test-alice", "Alice");
  assert.equal(requests[0].params.accountId, "avatar-test-alice");
  bus.emit("session.avatarChanged", { accountId: "avatar-test-alice" });
  assert.equal(requests.length, 2, "new save invalidates the original pending request");
  requests[1].resolve({ avatarDataB64: "TkVX" });
  await settle();
  requests[0].resolve({ avatarDataB64: "T0xE" });
  await settle();
  assert.equal(images(root)[0].attributes.get("src"), "data:image/jpeg;base64,TkVX");
  view.setAccount("avatar-test-bob", "Bob");
  assert.equal(images(root).length, 0, "different account never inherits Alice's image");
  view.unmount();
  view.mount(root);
  assert.equal(requests.length, 4, "remount starts a fresh request despite old pending work");
  requests[2].resolve({ avatarDataB64: "Qk9C" });
  await settle();
  assert.equal(images(root).length, 0, "old mount cannot repaint the new mount");
  requests[3].resolve({ avatarDataB64: "TkVXQk9C" });
  await settle();
  assert.equal(images(root)[0].attributes.get("src"), "data:image/jpeg;base64,TkVXQk9C");
  view.unmount();
  assert.equal(root.children.length, 0, "unmounted fetch cannot repaint");
});

test("web diagnostics show a version and distinguish count-only mesh status", () => {
  installFakeDom();
  const bus = new ChatServerBus();
  let mesh = { peerCount: 7, peers: [] };
  bus.stores.session = new SessionStore({ bus: null });
  bus.stores.connection = new ConnectionStore();
  bus.stores.connection.setConnection({ status: "connected", nodes: [{ url: "wss://chat.example/ws", active: true, ready: true, healthy: true }], mesh });
  const root = new FakeElement();
  const view = new SettingsTabView({ bus });
  view.mount(root);
  assert.match(text(root.querySelector('[data-testid="system.app-version"]')), /\d+\.\d+.*\(web\)/);
  assert.match(text(root.querySelector('[data-testid="system.mesh.peer.none"]')), /7 mesh peers.*details are unavailable/);
  assert.equal(text(root.querySelector('[data-testid="system.connected-node"]')), "Node: wss://chat.example/ws");
  mesh = { peerCount: 0, peers: [] };
  bus.stores.connection.setConnection({ mesh });
  assert.equal(text(root.querySelector('[data-testid="system.mesh.peer.none"]')), "No mesh peers reported");
  view.unmount();
});
