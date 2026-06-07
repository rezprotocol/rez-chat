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
