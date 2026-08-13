import test from "node:test";
import assert from "node:assert/strict";

import {
  bytesToBase64,
  deriveAccountIdFromPublicKey,
  durableRecordLocalId,
  durableRecordSignableBytes,
  base64ToBytes,
} from "@rezprotocol/core";
import { NodeCryptoProvider } from "@rezprotocol/node";
import { runDeviceLinkRequester } from "@rezprotocol/sdk/device-link";
import { ServerDeviceLinkService } from "../src/server/services/ServerDeviceLinkService.js";
import { DesktopVaultService } from "../electron/runtime/DesktopVaultService.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// S2.5 S10 C2 — the primary-side approver directives, un-mocked: a REAL sdk
// DeviceLinkRequester runs against the service over a node-rule-faithful
// in-memory overlay, and the resulting delegation provisions a REAL delegated
// vault row. Manual-approve is the pivot: the pending event carries the
// fingerprint, approve() must echo the pending newDeviceId, cancel is a veto.

const CRYPTO = new NodeCryptoProvider();
const FAST = { pollIntervalMs: 5, pollMaxIntervalMs: 10, pollBackoff: 1.2 };

function makeOverlay() {
  const map = new Map();
  return {
    async put({ record } = {}) {
      if (!record || record.v !== 1) throw new Error("overlay: bad record");
      const at = Date.now();
      if (record.expiresAtMs <= at) throw new Error("overlay: expired");
      if (record.issuedAtMs > at + 5 * 60_000) throw new Error("overlay: future-issuance");
      if (String(record.payloadB64 || "").length > 16384) throw new Error("overlay: too-large");
      const ok = CRYPTO.verify({
        publicKey: base64ToBytes(record.publisherPublicKeyB64),
        msg: durableRecordSignableBytes(record),
        sig: base64ToBytes(record.sigB64),
      });
      if (ok !== true) throw new Error("overlay: bad-signature");
      const localId = durableRecordLocalId(record);
      const existing = map.get(localId);
      if (existing && existing.sigB64 !== record.sigB64 && record.issuedAtMs < existing.issuedAtMs) {
        throw new Error("overlay: older-record");
      }
      map.set(localId, { ...record });
      return { localId, replicas: 1 };
    },
    async get({ recordKind, recordId, publisherPublicKeyB64 } = {}) {
      const record = map.get(durableRecordLocalId({ publisherPublicKeyB64, recordKind, recordId }));
      if (!record || record.expiresAtMs <= Date.now()) return null;
      return { ...record };
    },
  };
}

// A home that commits device.add and echoes back the registry rows it stored. Returning the
// COMMITTED rows (rather than the arguments) is what makes the approver's commit check meaningful:
// it is the home's own state that must bind this device, inbox, and leaf cert.
function makeMutationHome({ mutations = [], committedDevices = null, submitThrows = null, peersFailed = [] } = {}) {
  return async (payload) => {
    mutations.push(payload);
    if (submitThrows) throw new Error(submitThrows);
    const binding = payload.target.deviceInboxBinding;
    const capability = payload.target.deviceCapability;
    const devices = committedDevices || [{
      deviceId: binding.deviceId,
      inboxId: binding.inboxId,
      certId: capability.certId,
      status: "active",
    }];
    return {
      revision: 2,
      devices,
      authorityState: { epoch: 2, revokedCertIds: [], minValidIssuedAtMs: 0 },
      propagation: { peersPublished: 0, peersFailed },
    };
  };
}

function makeStorageProvider() {
  const data = new Map();
  const kv = {
    async get(k) { return data.has(k) ? JSON.parse(data.get(k)) : undefined; },
    async set(k, v) { data.set(k, JSON.stringify(v)); },
    async delete(k) { return data.delete(k); },
    async keys(prefix) {
      const out = [];
      for (const k of data.keys()) if (!prefix || k.startsWith(prefix)) out.push(k);
      return out;
    },
  };
  return { provider: { getKeyValueStore: () => kv }, data };
}

function makeBus({ overlay, hasAdminRoot = true, accountAuthority = null, accountIdentityDhKeyPair = null, onSubmit = null }) {
  const events = [];
  const calls = [];
  return {
    events,
    calls,
    runtime: {
      sdk: overlay ? { durableRecords: overlay } : null,
      peerLinks: { hasAdminRoot, cryptoProvider: CRYPTO },
      accountAuthority,
      accountIdentityDhKeyPair,
    },
    on() { return () => {}; },
    emit(name, payload) { events.push({ name, payload }); },
    registerFunction() {},
    call(namespace, name, payload) {
      calls.push({ namespace, name, payload });
      if (namespace === "account-mutation" && name === "submit" && onSubmit) return onSubmit(payload);
      return Promise.resolve(null);
    },
  };
}

function makePrimaryKeys() {
  const b = CRYPTO.generateSigningKeyPair();
  const dh = CRYPTO.dhGenerateKeyPair();
  const accountPubB64 = bytesToBase64(b.publicKey);
  return {
    accountPubB64,
    accountId: deriveAccountIdFromPublicKey(b.publicKey),
    authority: {
      signer: {
        getSignerRef() {
          return { accountId: deriveAccountIdFromPublicKey(b.publicKey), keyId: "invite-ed25519-v1", alg: "ed25519", signerPublicKeyB64: accountPubB64 };
        },
        async sign(bytes) { return CRYPTO.sign({ privateKey: b.privateKey, msg: bytes }); },
      },
    },
    accountIdentityDhKeyPair: {
      publicKeyB64: bytesToBase64(dh.publicKey),
      privateKeyB64: bytesToBase64(dh.privateKey),
    },
  };
}

function makeService({ overlay, keys, hasAdminRoot = true, dh = true, onSubmit = undefined, storageProvider = undefined, mutations = [] }) {
  const bus = makeBus({
    overlay,
    hasAdminRoot,
    accountAuthority: keys.authority,
    accountIdentityDhKeyPair: dh ? keys.accountIdentityDhKeyPair : null,
    onSubmit: onSubmit === undefined ? makeMutationHome({ mutations }) : onSubmit,
  });
  const storage = storageProvider === undefined ? makeStorageProvider().provider : storageProvider;
  const svc = new ServerDeviceLinkService({
    bus,
    ownerAccountId: keys.accountId,
    // P1#2a: the pending-ceremony journal is durable state, so the service needs a storage
    // provider to run a ceremony at all.
    storageProvider: storage,
    logger: { error() {}, warn() {}, info() {}, log() {} },
  });
  // The approver polls internally — shrink its cadence via the SDK defaults
  // by monkey-adjusting is not possible; the service passes only nowMs. The
  // default 1s poll is acceptable for these tests' timeouts.
  return { svc, bus, mutations };
}

async function waitForEvent(bus, state, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = bus.events.find((e) => e.name === "deviceLink.updated" && e.payload.state === state);
    if (hit) return hit.payload;
    if (Date.now() > deadline) throw new Error("timed out waiting for deviceLink.updated " + state);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("full ceremony through the directives: start → pending(fingerprint) → approve → confirmed; delegation provisions a REAL vault row", { timeout: 60_000 }, async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { svc, bus } = makeService({ overlay, keys });

  const started = await svc.startCeremony({});
  assert.match(started.linkCode, /^rez:link:v1:/);
  assert.ok(started.expiresAtMs > Date.now());
  await waitForEvent(bus, "code-issued");

  const requesterRun = runDeviceLinkRequester({
    code: started.linkCode,
    crypto: CRYPTO,
    records: overlay,
    persistDelegation: async () => null,
    ...FAST,
  });

  const pending = await waitForEvent(bus, "pending");
  assert.match(pending.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  assert.match(pending.newDeviceId, /^rez:dev:[0-9a-f]{64}$/);

  const statusPending = await svc.statusCeremony({});
  assert.equal(statusPending.state, "pending");
  assert.equal(statusPending.newDeviceId, pending.newDeviceId);

  const approved = await svc.approveCeremony({ newDeviceId: pending.newDeviceId });
  assert.equal(approved.state, "responding");

  const requester = await requesterRun;
  assert.equal(requester.deviceId, pending.newDeviceId, "the requester IS the approved device");
  assert.equal(requester.fingerprint, pending.fingerprint);
  await waitForEvent(bus, "confirmed");
  assert.equal((await svc.statusCeremony({})).state, "confirmed");

  // The ceremony output provisions a REAL delegated vault account.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rez-devlink-svc-"));
  const vault = new DesktopVaultService({
    dbPath: path.join(dir, "vault.sqlite"),
    safeStorage: {
      isEncryptionAvailable() { return true; },
      encryptString(v) { return Buffer.from("w:" + v, "utf8"); },
      decryptString(v) { const t = Buffer.from(v).toString("utf8"); return t.startsWith("w:") ? t.slice(2) : ""; },
    },
  }).open();
  const summary = await vault.createDelegatedAccount({
    profileName: "Linked",
    password: "correct horse battery staple",
    deviceKeyPair: requester.delegation.deviceKeyPair,
    delegationBundle: {
      accountSignPublicKeyB64: requester.delegation.accountSignPublicKeyB64,
      accountDhKeyPair: requester.delegation.accountDhKeyPair,
      certChain: requester.delegation.certChain,
      cachedDeviceSet: requester.delegation.cachedDeviceSet,
    },
  });
  assert.equal(summary.accountId, keys.accountId, "the linked vault row keys on the PRIMARY's account");
  const ident = vault.getChatServerIdentity();
  assert.equal(ident.hasAdminRoot, false);
  assert.equal(ident.publicKeyB64, keys.accountPubB64);
  vault.close();
});

test("approve with a mismatched newDeviceId is rejected and the ceremony stays pending", { timeout: 60_000 }, async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { svc, bus } = makeService({ overlay, keys });
  const started = await svc.startCeremony({});
  const requesterRun = runDeviceLinkRequester({
    code: started.linkCode, crypto: CRYPTO, records: overlay, persistDelegation: async () => null, ...FAST, deadlineMs: 20_000,
  }).catch((err) => err);

  const pending = await waitForEvent(bus, "pending");
  await assert.rejects(
    () => svc.approveCeremony({ newDeviceId: "rez:dev:" + "0".repeat(64) }),
    (err) => err.code === "DEVICE_ID_MISMATCH",
  );
  assert.equal((await svc.statusCeremony({})).state, "pending", "still pending after the bad approve");

  // The RIGHT approve still completes the ceremony.
  await svc.approveCeremony({ newDeviceId: pending.newDeviceId });
  const requester = await requesterRun;
  assert.equal(requester.deviceId, pending.newDeviceId);
  await waitForEvent(bus, "confirmed");
});

test("cancel while pending vetoes the ceremony; the requester never gets a bundle", { timeout: 60_000 }, async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { svc, bus } = makeService({ overlay, keys });
  const started = await svc.startCeremony({});
  const requesterRun = runDeviceLinkRequester({
    code: started.linkCode, crypto: CRYPTO, records: overlay, persistDelegation: async () => null, ...FAST, deadlineMs: 2_000,
  }).catch((err) => err);

  await waitForEvent(bus, "pending");
  const cancelled = await svc.cancelCeremony({});
  assert.equal(cancelled.state, "cancelled");
  await waitForEvent(bus, "cancelled");
  const requesterErr = await requesterRun;
  assert.ok(requesterErr instanceof Error);
  assert.equal(requesterErr.code, "DEVICE_LINK_TIMEOUT");
});

test("gates: delegated runtime, missing B-dh, double start, no pending approve", { timeout: 30_000 }, async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();

  const delegated = makeService({ overlay, keys, hasAdminRoot: false });
  await assert.rejects(() => delegated.svc.startCeremony({}), (err) => err.code === "DELEGATED_DEVICE");

  const noDh = makeService({ overlay, keys, dh: false });
  await assert.rejects(() => noDh.svc.startCeremony({}), /account identity-DH key unavailable/);

  const { svc } = makeService({ overlay, keys });
  await assert.rejects(() => svc.approveCeremony({ newDeviceId: "rez:dev:" + "0".repeat(64) }), (err) => err.code === "NO_PENDING_REQUEST");
  await svc.startCeremony({});
  await assert.rejects(() => svc.startCeremony({}), (err) => err.code === "LINK_IN_PROGRESS");
  await svc.cancelCeremony({});
  // After a terminal state a fresh start works (new PSK).
  const again = await svc.startCeremony({});
  assert.match(again.linkCode, /^rez:link:v1:/);
  await svc.cancelCeremony({});
});

// ---- L4: the service supplies registration-before-release + persist-and-resume ----

async function runFullCeremony({ overlay, keys, svc, bus }) {
  const started = await svc.startCeremony({});
  await waitForEvent(bus, "code-issued");
  const requesterRun = runDeviceLinkRequester({ code: started.linkCode, crypto: CRYPTO, records: overlay, persistDelegation: async () => null, ...FAST });
  const pending = await waitForEvent(bus, "pending");
  await svc.approveCeremony({ newDeviceId: pending.newDeviceId });
  const requester = await requesterRun;
  return { pending, requester };
}

test("L4: device.add carries the device's OWN inbox binding + the leaf cert, and the commit read back is the HOME's row", async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const mutations = [];
  const { svc, bus } = makeService({ overlay, keys, mutations });

  const { pending, requester } = await runFullCeremony({ overlay, keys, svc, bus });

  assert.equal(mutations.length, 1, "exactly one device.add");
  const submitted = mutations[0];
  assert.equal(submitted.action, "device.add");
  assert.equal(submitted.signWith, "account");
  // The binding is the NEW DEVICE's own, device-signed — the home keys its cursor on it.
  assert.equal(submitted.target.deviceInboxBinding.deviceId, pending.newDeviceId);
  assert.equal(submitted.target.deviceInboxBinding.inboxId, requester.inboxId);
  // ...and the leaf cert rides with it, so the home binds a REVOCABLE certId before release.
  assert.equal(typeof submitted.target.deviceCapability.certId, "string");
  assert.ok(submitted.target.deviceCapability.certId.startsWith("rez:cap:"));
});

test("L4 fail-closed: a home that commits a DIFFERENT device never releases the leaf", async () => {
  // The approver validates the commit against the leaf it minted. Returning the home's committed
  // rows (not an echo of the arguments) is what lets this be caught at all.
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { svc, bus } = makeService({
    overlay,
    keys,
    onSubmit: makeMutationHome({
      committedDevices: [{ deviceId: "rez:dev:" + "f".repeat(64), inboxId: "inbox:" + "0".repeat(24), certId: "rez:cap:" + "0".repeat(64), status: "active" }],
    }),
  });

  const started = await svc.startCeremony({});
  await waitForEvent(bus, "code-issued");
  const requesterRun = runDeviceLinkRequester({ code: started.linkCode, crypto: CRYPTO, records: overlay, persistDelegation: async () => null, deadlineMs: 1200, ...FAST })
    .then(() => null).catch((err) => err);
  const pending = await waitForEvent(bus, "pending");
  await svc.approveCeremony({ newDeviceId: pending.newDeviceId });

  const reqErr = await requesterRun;
  assert.ok(reqErr, "the requester never received a bundle");
  const failed = bus.events.filter((e) => e.payload && e.payload.state === "failed");
  assert.ok(failed.length > 0, "the ceremony failed rather than releasing an unbound leaf");
});

test("L4: a PROPAGATION failure does not withhold a leaf whose registration committed", async () => {
  // Commit != propagation. The device.add is durably committed and the authority-state obligation
  // is durable in the node outbox; treating a peer republish failure as a registration failure
  // would orphan a device the home has already registered.
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { svc, bus } = makeService({
    overlay,
    keys,
    onSubmit: makeMutationHome({ peersFailed: [{ peerAccountId: "rez:acct:peer", reason: "offline" }] }),
  });

  const { pending, requester } = await runFullCeremony({ overlay, keys, svc, bus });
  assert.equal(requester.deviceId, pending.newDeviceId, "the leaf WAS released");
});

test("L4 fail-closed: a failing device.add fails the ceremony and releases nothing", async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { svc, bus } = makeService({ overlay, keys, onSubmit: makeMutationHome({ submitThrows: "home unreachable" }) });

  const started = await svc.startCeremony({});
  await waitForEvent(bus, "code-issued");
  const requesterRun = runDeviceLinkRequester({ code: started.linkCode, crypto: CRYPTO, records: overlay, persistDelegation: async () => null, deadlineMs: 1200, ...FAST })
    .then(() => null).catch((err) => err);
  const pending = await waitForEvent(bus, "pending");
  await svc.approveCeremony({ newDeviceId: pending.newDeviceId });

  const reqErr = await requesterRun;
  assert.ok(reqErr, "no leaf reached the new device");
});

test("L4: the ceremony is durably journaled — pending BEFORE device.add, then published, then confirmed", async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { provider, data } = makeStorageProvider();
  const mutations = [];
  // Observe the store's write order against the device.add: the record must exist first.
  let stateWhenSubmitted = null;
  const onSubmit = async (payload) => {
    const keysAtSubmit = [...data.keys()].filter((k) => k.startsWith("app:pendingceremony/"));
    stateWhenSubmitted = keysAtSubmit.length > 0 ? JSON.parse(data.get(keysAtSubmit[0])).state : null;
    return makeMutationHome({ mutations })(payload);
  };
  const { svc, bus } = makeService({ overlay, keys, storageProvider: provider, onSubmit });

  const { pending } = await runFullCeremony({ overlay, keys, svc, bus });
  // markConfirmed runs when the approver's poll observes the device's confirm record, which is
  // AFTER the requester resolves — wait for the ceremony's own terminal event, not the requester.
  await waitForEvent(bus, "confirmed");

  assert.equal(stateWhenSubmitted, "pending", "the resume record existed BEFORE device.add ran");
  const stored = JSON.parse(data.get("app:pendingceremony/" + pending.newDeviceId));
  assert.equal(stored.state, "confirmed", "and advanced through published to confirmed");
  assert.equal(stored.deviceId, pending.newDeviceId);
  assert.ok(stored.sealedResponse, "the exact publication is retained for resume");
  assert.ok(stored.confirmTagB64.length > 0);
  assert.equal(stored.masterSecret, undefined, "no key material at rest");
});

test("L4: a ceremony cannot start without the durable journal", async () => {
  const overlay = makeOverlay();
  const keys = makePrimaryKeys();
  const { svc } = makeService({ overlay, keys, storageProvider: null });
  await assert.rejects(() => svc.startCeremony({}), /requires a storageProvider for the pending-ceremony journal/);
});
