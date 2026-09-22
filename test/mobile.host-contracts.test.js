import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createKeystoreAccount, KeystoreStore } from "@rezprotocol/sdk/client";
import { NativePrimitiveClient } from "@rezprotocol/sdk/native";
import { MobileApplicationHost } from "../src/mobile/MobileApplicationHost.js";
import { MobileRuntimeHost } from "../src/mobile/MobileRuntimeHost.js";
import { SessionHelloResult } from "../src/records/results/SessionHelloResult.js";
import { MobileAccountSocketGate } from "../src/mobile/MobileAccountSocketGate.js";
import { MobileAccountListV1, MobileHostConfigV1, MobileHostRequestV1, MobileLifecycleRequestV1, MobileLifecycleResultV1 } from "../src/mobile/MobileHostRecords.js";

const config = () => new MobileHostConfigV1({ accountHomeUplinks: ["wss://home.example.invalid/ws"], portableUplinks: ["wss://portable.example.invalid/ws"] });
const wake = (id, name = "onPushWake") => new MobileLifecycleRequestV1({ id, name });
if (!globalThis.crypto) globalThis.crypto = webcrypto;

function primitive(values = new Map()) {
  return new NativePrimitiveClient((requestJson) => {
    const request = JSON.parse(requestJson);
    if (request.method === "storage.get") {
      const key = JSON.stringify([request.args[0], request.args[1]]);
      return JSON.stringify({ ok: true, values: values.has(key) ? [true, values.get(key)] : [false, ""] });
    }
    if (request.method === "storage.set") {
      values.set(JSON.stringify([request.args[0], request.args[1]]), request.args[2]);
      return JSON.stringify({ ok: true, values: [] });
    }
    if (request.method === "storage.delete") {
      const deleted = values.delete(JSON.stringify([request.args[0], request.args[1]]));
      return JSON.stringify({ ok: true, values: [deleted] });
    }
    if (request.method === "storage.keys") {
      const scope = request.args[0];
      const prefix = request.args[1];
      const keys = [];
      for (const encoded of values.keys()) {
        const pair = JSON.parse(encoded);
        if (pair[0] === scope && pair[1].startsWith(prefix)) keys.push(pair[1]);
      }
      return JSON.stringify({ ok: true, values: keys });
    }
    if (request.method === "storage.acquireOwner") return JSON.stringify({ ok: true, values: [1, "token"] });
    return JSON.stringify({ ok: true, values: [] });
  });
}

function memoryStorage() {
  const values = new Map();
  return {
    get: (key) => values.has(key) ? values.get(key) : null,
    put: (key, value) => values.set(key, value),
    del: (key) => values.delete(key),
  };
}

test("mobile account list exposes the canonical Rez account id without a host-specific alias", () => {
  const list = new MobileAccountListV1(
    [{ id: "default", accountIdHint: "rez:acct:phone", label: "Mini me", recoveryEnabled: true }],
  );
  assert.equal(list.accounts[0].id, "default");
  assert.equal(list.accounts[0].label, "Mini me");
  assert.equal(list.accounts[0].accountIdHint, "rez:acct:phone");
});

test("native account creation feeds the shared session label used by invite acceptance", async () => {
  let response = null;
  const host = new MobileApplicationHost(config(), primitive(), (record) => { response = record; });
  const call = async (id, operation, params = {}) => {
    response = null;
    await host.dispatch(new MobileHostRequestV1({ id, operation, paramsJson: JSON.stringify(params) }));
    assert.equal(response.ok, true, response.error);
    return JSON.parse(response.resultJson);
  };
  const created = await call("create", "vault.createAccount", {
    profileName: "Phone contact name",
    password: "long-enough-password",
  });
  const listed = await call("list", "vault.listAccounts");
  assert.equal(listed.accounts[0].id, "default");
  assert.equal(listed.accounts[0].accountIdHint, created.accountId);
  assert.equal(listed.accounts[0].label, "Phone contact name");
  const session = new (await import("../src/ui/stores/SessionStore.js")).SessionStore();
  session.setAccountList(listed.accounts);
  session.setSelectedAccountId("default");
  session.setUnlocked({ accountId: created.accountId, deviceId: created.deviceId });
  assert.equal(session.selfLabel(), "Phone contact name");
});

test("legacy phone custody migrates once into the canonical account registry", async () => {
  const password = "legacy-phone-password";
  const storage = memoryStorage();
  const keystore = new KeystoreStore({ storageProvider: storage });
  const created = await createKeystoreAccount({
    password,
    profileName: "Migrated phone",
    keystoreStore: keystore,
  });
  const nativeValues = new Map();
  nativeValues.set(JSON.stringify(["mobile:vault", "account"]), JSON.stringify({
    envelope: await keystore.getKeystoreEnvelope(),
    accountId: created.accountId,
    recoveryEnvelope: null,
    recoveryKeystore: null,
    label: "Migrated phone",
    avatar: {},
  }));
  let response = null;
  const host = new MobileApplicationHost(config(), primitive(nativeValues), (record) => { response = record; });
  await host.dispatch(new MobileHostRequestV1({ id: "list", operation: "vault.listAccounts", paramsJson: "{}" }));
  assert.equal(response.ok, true, response.error);
  const listed = JSON.parse(response.resultJson);
  assert.equal(listed.accounts[0].label, "Migrated phone");
  assert.equal(listed.accounts[0].accountIdHint, created.accountId);
  assert.equal(nativeValues.has(JSON.stringify(["mobile:vault", "account"])), false);
  assert.equal(nativeValues.has(JSON.stringify(["", "default"])), true);
  await host.dispatch(new MobileHostRequestV1({ id: "unlock", operation: "vault.unlock", paramsJson: JSON.stringify({ password }) }));
  assert.equal(response.ok, true, response.error);
  assert.equal(JSON.parse(response.resultJson).profileName, "Migrated phone");
});

test("cold unlock/connect converges after the foreground event was consumed while locked", async (t) => {
  const originalConnect = MobileRuntimeHost.prototype.connect;
  const originalLifecycle = MobileRuntimeHost.prototype.lifecycle;
  t.after(() => {
    MobileRuntimeHost.prototype.connect = originalConnect;
    MobileRuntimeHost.prototype.lifecycle = originalLifecycle;
  });
  const observed = [];
  MobileRuntimeHost.prototype.connect = async () => {
    observed.push("connect");
    return new SessionHelloResult({ accountId: "test", ownerAccountId: "test", deviceId: "device", localInboxId: "inbox" });
  };
  MobileRuntimeHost.prototype.lifecycle = async (name) => { observed.push(name); return null; };
  const host = new MobileApplicationHost(config(), primitive(), (record) => observed.push(record.ok ? "ready" : "failed"));
  await host.dispatch(new MobileHostRequestV1({ id: "create", operation: "vault.createAccount", paramsJson: JSON.stringify({ profileName: "Shared auth", password: "long-enough-password" }) }));
  assert.deepEqual(observed, ["ready"]);
  observed.length = 0;
  await host.dispatch(new MobileHostRequestV1({ id: "connect", operation: "runtime.connect", paramsJson: "{}" }));
  assert.deepEqual(observed, ["connect", "onForeground", "ready"]);
});

test("native wake result cannot claim success while locked, offline, partially failed, or missing a readiness step", () => {
  for (const report of [null, { live: false, steps: {} }, { live: true, steps: { drain: { ok: false } } }, { live: true, steps: { drain: { ok: true, skipped: true } } }]) {
    assert.equal(new MobileLifecycleResultV1(wake("w"), report).ok, false);
  }
  assert.equal(new MobileLifecycleResultV1(wake("w", "onBackground"), { suspended: false, reason: "suspend-failed" }).ok, false);
  assert.equal(new MobileLifecycleResultV1(wake("w", "onBackground"), { suspended: false, reason: "no-account-control" }).ok, true);
});

test("host passes wake storms concurrently to the adapter while account operations remain exclusive", async (t) => {
  const lifecycle = MobileRuntimeHost.prototype.lifecycle;
  const disconnect = MobileRuntimeHost.prototype.disconnect;
  t.after(() => { MobileRuntimeHost.prototype.lifecycle = lifecycle; MobileRuntimeHost.prototype.disconnect = disconnect; });
  const releases = [];
  const observed = [];
  MobileRuntimeHost.prototype.lifecycle = async function(name) {
    observed.push(name);
    await new Promise((resolve) => releases.push(resolve));
    return { live: true, steps: { drain: { ok: true } } };
  };
  MobileRuntimeHost.prototype.disconnect = async function() { observed.push("disconnect"); };
  const emitted = [];
  const host = new MobileApplicationHost(config(), primitive(), (record) => emitted.push(record));
  const first = host.lifecycle(wake("one"));
  const second = host.lifecycle(wake("two", "onNetworkAvailable"));
  const lock = host.dispatch(new MobileHostRequestV1({ id: "lock", operation: "vault.lock", paramsJson: "{}" }));
  const afterLock = host.lifecycle(wake("after-lock", "onForeground"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, ["onPushWake", "onNetworkAvailable"]);
  releases.splice(0).forEach((release) => release());
  await Promise.all([first, second, lock]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, ["onPushWake", "onNetworkAvailable", "disconnect", "onForeground"]);
  releases.splice(0).forEach((release) => release());
  await afterLock;
  assert.deepEqual(emitted.map((record) => record.id).sort(), ["after-lock", "lock", "one", "two"]);
  assert.equal(emitted.every((record) => record.ok), true);
});

test("mobile deployment rejects insecure or credential-bearing provider endpoints", () => {
  for (const value of ["ws://host/ws", "https://host/ws", "wss://user:password@host/ws", "wss://host/ws#fragment"]) {
    assert.throws(() => new MobileHostConfigV1({ accountHomeUplinks: [value], portableUplinks: ["wss://portable/ws"] }));
  }
  assert.throws(() => new MobileLifecycleRequestV1({ id: "w", name: "executeAccountOperation" }));
});

test("account transports require foreground and close immediately on background", () => {
  let opens = 0;
  let closes = 0;
  const gate = new MobileAccountSocketGate(() => {
    opens += 1;
    const socket = new EventTarget();
    socket.close = () => { closes += 1; socket.dispatchEvent(new Event("close")); };
    return socket;
  });
  assert.throws(() => gate.open("wss://home/ws"), /foreground/);
  gate.foreground();
  gate.open("wss://home/ws");
  gate.open("wss://home/ws");
  gate.background();
  assert.equal(opens, 2);
  assert.equal(closes, 2);
  assert.throws(() => gate.open("wss://home/ws"), /foreground/);
  gate.foreground();
  gate.open("wss://home/ws");
  assert.equal(opens, 3);
});

test("background stand-down bypasses a pending convergence operation", async (t) => {
  const original = MobileRuntimeHost.prototype.lifecycle;
  t.after(() => { MobileRuntimeHost.prototype.lifecycle = original; });
  let release;
  let suspended = false;
  MobileRuntimeHost.prototype.lifecycle = async function(name) {
    if (name === "onBackground") { suspended = true; return { suspended: true }; }
    await new Promise((resolve) => { release = resolve; });
    return { live: true, steps: {} };
  };
  const emitted = [];
  const host = new MobileApplicationHost(config(), primitive(), (record) => emitted.push(record));
  const pending = host.lifecycle(wake("slow"));
  await new Promise((resolve) => setImmediate(resolve));
  await host.lifecycle(wake("background", "onBackground"));
  assert.equal(suspended, true);
  assert.equal(emitted[0].id, "background");
  assert.equal(emitted[0].ok, true);
  release();
  await pending;
});
