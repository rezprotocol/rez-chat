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

function makeBus({ overlay, hasAdminRoot = true, accountAuthority = null, accountIdentityDhKeyPair = null }) {
  const events = [];
  return {
    events,
    runtime: {
      sdk: overlay ? { durableRecords: overlay } : null,
      peerLinks: { hasAdminRoot, cryptoProvider: CRYPTO },
      accountAuthority,
      accountIdentityDhKeyPair,
    },
    on() { return () => {}; },
    emit(name, payload) { events.push({ name, payload }); },
    registerFunction() {},
    call() { return Promise.resolve(null); },
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

function makeService({ overlay, keys, hasAdminRoot = true, dh = true }) {
  const bus = makeBus({
    overlay,
    hasAdminRoot,
    accountAuthority: keys.authority,
    accountIdentityDhKeyPair: dh ? keys.accountIdentityDhKeyPair : null,
  });
  const svc = new ServerDeviceLinkService({
    bus,
    ownerAccountId: keys.accountId,
    logger: { error() {}, warn() {}, info() {}, log() {} },
  });
  // The approver polls internally — shrink its cadence via the SDK defaults
  // by monkey-adjusting is not possible; the service passes only nowMs. The
  // default 1s poll is acceptable for these tests' timeouts.
  return { svc, bus };
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
    code: started.linkCode, crypto: CRYPTO, records: overlay, ...FAST, deadlineMs: 20_000,
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
    code: started.linkCode, crypto: CRYPTO, records: overlay, ...FAST, deadlineMs: 2_000,
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
