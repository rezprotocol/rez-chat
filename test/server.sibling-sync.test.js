// AE-2 (plans/ORIGINAL_MESSAGE_ANTIENTROPY_PLAN.md §3/§4): sibling
// anti-entropy convergence over the immutable OriginalMessage fact log.
// Two REAL ChatServerApps (two devices of one account) wired through a
// loopback of the sealed sibling channel; facts are REAL signed
// OriginalMessages (NodeCryptoProvider), admitted through the REAL ingest
// seam. Frozen rules under test: the sibling is transport never authority;
// admission never defaults permissive when the revocation source is
// unavailable (defer); unsigned facts are never sync-eligible; the
// reconciliation set is FINGERPRINTS; conflicts transfer as two facts and
// flag the projection with no winner.

import test from "node:test";
import assert from "node:assert/strict";

import {
  bytesToBase64,
  base64ToBytes,
  deriveAccountIdFromPublicKey,
  deriveDeviceIdFromPublicKeyB64,
} from "@rezprotocol/sdk/client";
import { NodeCryptoProvider } from "@rezprotocol/node";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { MESSAGE_KIND } from "../src/records/payloads/ChatMessagePayloadV1.js";
import { MESSAGE_EDIT_KIND } from "../src/records/payloads/ChatMessageEditPayloadV1.js";
import { SiblingSyncPayloadV1 } from "../src/records/payloads/SiblingSyncPayloadV1.js";
import {
  signableOriginalMessageBytes,
  messageFingerprint,
  fingerprintSetDigest,
} from "../src/records/payloads/originalMessageShapes.js";

const CRYPTO = new NodeCryptoProvider();

class TestKVStore {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async getStrict(key) { return this._data.has(key) ? this._data.get(key) : undefined; }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}
class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
}

const FAKE_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const OWNER = "rez:acct:owner";
const THREAD = "th_owner_bob";

// The loopback "mesh": inboxId → app; dispatched sync payloads queue and a
// drain() pump applies them in order (deterministic, no live sockets). Every
// message's op is recorded so tests can assert traffic shape.
class LoopbackNetwork {
  constructor() {
    this.routes = new Map();
    this.queue = [];
    this.opLog = [];
  }
  register(inboxId, app) { this.routes.set(inboxId, app); }
  push(inboxId, bytes) { this.queue.push({ inboxId, bytes }); }
  async drain() {
    while (this.queue.length > 0) {
      const { inboxId, bytes } = this.queue.shift();
      const app = this.routes.get(inboxId);
      if (!app) continue;
      const json = JSON.parse(new TextDecoder().decode(bytes));
      this.opLog.push(json.op);
      const record = new SiblingSyncPayloadV1(json);
      await app.bus.services.siblingSync.handleInbound(record);
    }
  }
}

function makeSender() {
  const kp = CRYPTO.generateSigningKeyPair();
  return {
    keyPair: kp,
    pubB64: bytesToBase64(kp.publicKey),
    accountId: deriveAccountIdFromPublicKey(kp.publicKey),
  };
}

// A DIRECT-mode signed base OriginalMessage as raw wire JSON.
function signedBaseFact(sender, { messageId, text, threadId = THREAD }) {
  const semantic = {
    kind: MESSAGE_KIND,
    threadId,
    senderAccountId: sender.accountId,
    messageId,
    text,
    inReplyToMessageId: "",
    channelId: "",
    signerPublicKeyB64: sender.pubB64,
    senderDeviceId: "",
    senderAuthorityEpoch: 0,
  };
  const bytes = signableOriginalMessageBytes(semantic);
  return {
    ...semantic,
    senderCertChain: [],
    contentHash: messageFingerprint(semantic),
    sig: bytesToBase64(CRYPTO.sign({ privateKey: sender.keyPair.privateKey, msg: bytes })),
  };
}

function signedEditFact(sender, { targetMessageId, targetFingerprint, newText, editedAtMs, threadId = THREAD }) {
  const semantic = {
    kind: MESSAGE_EDIT_KIND,
    threadId,
    targetMessageId,
    targetFingerprint,
    newText,
    senderAccountId: sender.accountId,
    editedAtMs,
    signerPublicKeyB64: sender.pubB64,
    senderDeviceId: "",
    senderAuthorityEpoch: 0,
  };
  const bytes = signableOriginalMessageBytes(semantic);
  return {
    ...semantic,
    senderCertChain: [],
    contentHash: messageFingerprint(semantic),
    sig: bytesToBase64(CRYPTO.sign({ privateKey: sender.keyPair.privateKey, msg: bytes })),
  };
}

async function makeDevice({ network, inboxId, peerAccountId }) {
  const deviceKeyPair = CRYPTO.generateSigningKeyPair();
  const devicePublicKeyB64 = bytesToBase64(deviceKeyPair.publicKey);
  const deviceId = deriveDeviceIdFromPublicKeyB64(devicePublicKeyB64);

  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: OWNER, deviceId },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new TestStorageProvider(),
    ownerAccountId: OWNER,
    clock: () => Date.now(),
  });

  const peerLinks = {
    deviceId,
    devicePublicKeyB64,
    cryptoProvider: CRYPTO,
    async signAccountStateEvent(signableBytes) {
      const sig = CRYPTO.sign({ privateKey: deviceKeyPair.privateKey, msg: signableBytes });
      return { originDeviceId: deviceId, originDevicePublicKeyB64: devicePublicKeyB64, sigB64: bytesToBase64(sig) };
    },
    async verifyAccountStateEventSig({ signableBytes, originDeviceId, originDevicePublicKeyB64, sigB64 } = {}) {
      try {
        if (deriveDeviceIdFromPublicKeyB64(originDevicePublicKeyB64) !== originDeviceId) return false;
        return CRYPTO.verify({
          publicKey: base64ToBytes(originDevicePublicKeyB64),
          msg: signableBytes,
          sig: base64ToBytes(sigB64),
        }) === true;
      } catch (err) {
        return false;
      }
    },
  };

  const device = { app, deviceId, inboxId, siblings: [] };
  const sdk = {
    devices: { getAuthorityState: async () => ({ epoch: 0, revokedCertIds: [] }) },
    listSiblingDeviceInboxes: async () => device.siblings.map((s) => ({ deviceId: s.deviceId, inboxId: s.inboxId })),
    buildAccountStateDeposit: async ({ deliverInboxId, plaintextBodyBytes }) => ({
      object: { deliverInboxId, plaintextBodyBytes },
      address: deliverInboxId,
    }),
    mesh: { dispatch: async (object) => { network.push(object.deliverInboxId, object.plaintextBodyBytes); } },
  };
  Object.assign(app.bus.runtime, { multiDeviceFanout: true, peerLinks, sdk });

  // The canonical peer revocation source, controllable per test. Default:
  // established, no revocations (a published-nothing peer).
  device.revocation = { enabled: true, error: null, state: null };
  app.bus.services.accountMutation = {
    isEnabled: () => device.revocation.enabled,
    getPeerRevocationState: async () => {
      if (device.revocation.error) throw device.revocation.error;
      return device.revocation.state;
    },
  };

  await app.bus.services.threads.ensureDirectThread({
    threadId: THREAD,
    peerAccountId,
    peerInboxId: "inbox:bob",
    createdAtMs: 1000,
  });
  network.register(inboxId, app);
  return device;
}

function pair(a, b) {
  a.siblings = [{ deviceId: b.deviceId, inboxId: b.inboxId }];
  b.siblings = [{ deviceId: a.deviceId, inboxId: a.inboxId }];
}

async function setupPair() {
  const network = new LoopbackNetwork();
  const bob = makeSender();
  const A = await makeDevice({ network, inboxId: "inbox:devA", peerAccountId: bob.accountId });
  const B = await makeDevice({ network, inboxId: "inbox:devB", peerAccountId: bob.accountId });
  pair(A, B);
  return { network, bob, A, B };
}

// Deliver a fact into a device through the LIVE ingest seam (as if it
// arrived over the sealed peer session) — this is how devices accrue facts.
async function deliverLive(device, fact) {
  await device.app.bus.services.events.applyUserMessage({
    eventId: "evt_" + fact.contentHash.slice(0, 12),
    mailboxId: device.inboxId,
    senderAccountId: fact.senderAccountId,
    plaintextB64: Buffer.from(JSON.stringify(fact)).toString("base64"),
  });
}

async function fingerprintsOf(device) {
  return device.app.bus.stores.threadStore.listOriginalFingerprints({ threadId: THREAD });
}

async function messagesOf(device) {
  const page = await device.app.bus.stores.threadStore.listMessages({ threadId: THREAD, limit: 50 });
  return page && Array.isArray(page.items) ? page.items : [];
}

test("SiblingSyncPayloadV1 validates op-specific shape", () => {
  const base = {
    threadId: THREAD,
    originDeviceId: "rez:dev:abcdef",
    originDevicePublicKeyB64: "pub",
    issuedAtMs: 1,
    sig: "sig",
  };
  const digest = new SiblingSyncPayloadV1({ ...base, op: "digest", messageCount: 0, setDigest: fingerprintSetDigest([]) });
  assert.equal(digest.op, "digest");
  assert.throws(() => new SiblingSyncPayloadV1({ ...base, op: "digest", messageCount: 3 }), /setDigest/);
  assert.throws(() => new SiblingSyncPayloadV1({ ...base, op: "digest", messageCount: -1, setDigest: "d" }), /messageCount/);
  assert.throws(() => new SiblingSyncPayloadV1({ ...base, op: "transfer", facts: [] }), /facts/);
  assert.throws(() => new SiblingSyncPayloadV1({ ...base, op: "inventory", items: [{ messageId: "m" }] }), /fingerprint/);
});

test("fingerprintSetDigest is order-independent, deduped, and content-sensitive", () => {
  const d1 = fingerprintSetDigest(["b", "a", "c"]);
  assert.equal(fingerprintSetDigest(["c", "a", "b", "a"]), d1);
  assert.notEqual(fingerprintSetDigest(["a", "b"]), d1);
  assert.equal(fingerprintSetDigest([]), fingerprintSetDigest([]));
});

test("an empty sibling converges to the full fact set (digest → inventory → transfer → admit)", async () => {
  const { network, bob, A, B } = await setupPair();
  const facts = [
    signedBaseFact(bob, { messageId: "m1", text: "one" }),
    signedBaseFact(bob, { messageId: "m2", text: "two" }),
    signedBaseFact(bob, { messageId: "m3", text: "three" }),
  ];
  for (const fact of facts) await deliverLive(A, fact);
  assert.equal((await fingerprintsOf(A)).length, 3, "A holds the live-admitted facts");
  assert.equal((await fingerprintsOf(B)).length, 0);

  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();

  const aSet = await fingerprintsOf(A);
  const bSet = await fingerprintsOf(B);
  assert.deepEqual(bSet, aSet, "fact sets converged");
  const rows = await messagesOf(B);
  for (const fact of facts) {
    const row = rows.find((m) => m.messageId === fact.messageId);
    assert.ok(row, "projection row for " + fact.messageId);
    assert.equal(row.text, fact.text);
    assert.equal(row.senderAccountId, bob.accountId);
  }
});

test("bidirectional partial overlap converges both siblings to the union", async () => {
  const { network, bob, A, B } = await setupPair();
  const f1 = signedBaseFact(bob, { messageId: "m1", text: "only-A" });
  const f2 = signedBaseFact(bob, { messageId: "m2", text: "shared" });
  const f3 = signedBaseFact(bob, { messageId: "m3", text: "only-B" });
  await deliverLive(A, f1);
  await deliverLive(A, f2);
  await deliverLive(B, f2);
  await deliverLive(B, f3);

  await A.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();

  const aSet = await fingerprintsOf(A);
  const bSet = await fingerprintsOf(B);
  assert.deepEqual(aSet, bSet, "both converged to one set");
  assert.equal(aSet.length, 3);
  assert.ok((await messagesOf(A)).find((m) => m.messageId === "m3"), "A gained only-B");
  assert.ok((await messagesOf(B)).find((m) => m.messageId === "m1"), "B gained only-A");
});

test("mutation facts transfer as immutable records and fold on the receiver", async () => {
  const { network, bob, A, B } = await setupPair();
  const base = signedBaseFact(bob, { messageId: "m1", text: "original" });
  const edit = signedEditFact(bob, {
    targetMessageId: "m1",
    targetFingerprint: base.contentHash,
    newText: "edited",
    editedAtMs: Date.now(),
  });
  await deliverLive(A, base);
  await deliverLive(A, edit);
  assert.equal((await fingerprintsOf(A)).length, 2, "base + mutation are both facts on A");

  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();

  const bSet = await fingerprintsOf(B);
  assert.equal(bSet.length, 2, "both immutable records transferred");
  const editFact = await B.app.bus.stores.threadStore.getOriginalFact({ threadId: THREAD, fingerprint: edit.contentHash });
  assert.equal(editFact.targetFingerprint, base.contentHash, "the mutation edge survives transfer");
  const row = (await messagesOf(B)).find((m) => m.messageId === "m1");
  assert.equal(row.text, "edited", "the projection folded the transferred edit");
});

test("a conflicted identity transfers BOTH facts; the receiver flags conflicted and picks no winner", async () => {
  const { network, bob, A, B } = await setupPair();
  const factX = signedBaseFact(bob, { messageId: "m1", text: "version X" });
  const factY = signedBaseFact(bob, { messageId: "m1", text: "version Y" });
  await deliverLive(A, factX);
  await deliverLive(A, factY);
  assert.equal((await fingerprintsOf(A)).length, 2, "A retains both signed facts");

  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();

  const bSet = await fingerprintsOf(B);
  assert.deepEqual(bSet.sort(), [factX.contentHash, factY.contentHash].sort(), "both facts admitted at B");
  const row = (await messagesOf(B)).find((m) => m.messageId === "m1");
  assert.ok(row, "one projection row carries the flag");
  assert.equal(row.conflicted, true, "the conflict is surfaced — no winner is chosen");
});

test("unsigned facts are never sync-eligible", async () => {
  const { bob, A, B } = await setupPair();
  const unsigned = {
    kind: MESSAGE_KIND, threadId: THREAD, senderAccountId: bob.accountId, messageId: "mu", text: "legacy",
  };
  const peerLinks = A.app.bus.runtime.peerLinks;
  const body = {
    op: "transfer", threadId: THREAD, facts: [unsigned],
    originDeviceId: A.deviceId, originDevicePublicKeyB64: peerLinks.devicePublicKeyB64, issuedAtMs: Date.now(),
  };
  const signed = await peerLinks.signAccountStateEvent(SiblingSyncPayloadV1.signableBytes(body));
  const record = new SiblingSyncPayloadV1({ ...body, sig: signed.sigB64 });

  const result = await B.app.bus.services.siblingSync.handleInbound(record);
  assert.equal(result.admitted, 0);
  assert.equal(result.deferred, 0, "an unsigned fact is REJECTED, not deferred — nothing should retry it");
  assert.equal((await fingerprintsOf(B)).length, 0);
  assert.equal((await messagesOf(B)).length, 0, "nothing reached the projection either");
});

test("sibling admission DEFERS (never admits) when the revocation source is unavailable", async () => {
  const { network, bob, A, B } = await setupPair();
  const fact = signedBaseFact(bob, { messageId: "m1", text: "hello" });
  await deliverLive(A, fact);

  // B cannot establish the sender's authority state: source disabled.
  B.revocation.enabled = false;
  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();
  assert.equal((await fingerprintsOf(B)).length, 0, "nothing admitted while the source is unavailable");

  // Source throws (fetch failure) — same defer, not admit.
  B.revocation.enabled = true;
  B.revocation.error = new Error("relay unreachable");
  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();
  assert.equal((await fingerprintsOf(B)).length, 0, "fetch failure defers too");

  // Source recovers → the same boring loop converges.
  B.revocation.error = null;
  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();
  assert.deepEqual(await fingerprintsOf(B), await fingerprintsOf(A), "deferred facts admit once the source is available");
});

test("a fact from a revoked device is rejected at sibling admission (forward-looking revocation)", async () => {
  const { network, A, B } = await setupPair();
  // Cert-mode sender: account B' delegates to device C; the receiver has
  // OBSERVED C's leaf revoked.
  const account = makeSender();
  const deviceKp = CRYPTO.generateSigningKeyPair();
  const devicePubB64 = bytesToBase64(deviceKp.publicKey);
  const { AccountDeviceCapabilityV1, ACCOUNT_DEVICE_CAPABILITY_PURPOSE, DeviceRegistrationV1 } = await import("@rezprotocol/core");
  const fields = {
    v: 1,
    purpose: ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
    accountIdentityPublicKeyB64: account.pubB64,
    parentCertId: null,
    granteeDevicePublicKeyB64: devicePubB64,
    granteeDeviceId: DeviceRegistrationV1.deviceIdFor(devicePubB64),
    capabilities: ["peerLink.create"],
    maxDelegationDepth: 0,
    issuedAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 86400000,
    signerPublicKeyB64: account.pubB64,
  };
  const certId = AccountDeviceCapabilityV1.deriveCertId(fields);
  const certSig = CRYPTO.sign({ privateKey: account.keyPair.privateKey, msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }) });
  const leaf = new AccountDeviceCapabilityV1({ ...fields, certId, sig: { alg: "ed25519", sigB64: bytesToBase64(certSig) } }).toJSON();

  // Both devices know this sender (thread peer stays bob; use a second
  // thread bound to the cert-mode account).
  const certThread = "th_owner_certpeer";
  for (const device of [A, B]) {
    await device.app.bus.services.threads.ensureDirectThread({
      threadId: certThread, peerAccountId: account.accountId, peerInboxId: "inbox:certpeer", createdAtMs: 1000,
    });
  }
  const semantic = {
    kind: MESSAGE_KIND, threadId: certThread, senderAccountId: account.accountId,
    messageId: "mc1", text: "from device C", inReplyToMessageId: "", channelId: "",
    signerPublicKeyB64: devicePubB64,
    senderDeviceId: DeviceRegistrationV1.deviceIdFor(devicePubB64),
    senderAuthorityEpoch: 1,
  };
  const fact = {
    ...semantic,
    senderCertChain: [leaf],
    contentHash: messageFingerprint(semantic),
    sig: bytesToBase64(CRYPTO.sign({ privateKey: deviceKp.privateKey, msg: signableOriginalMessageBytes(semantic) })),
  };
  await deliverLive(A, fact);
  assert.equal((await A.app.bus.stores.threadStore.listOriginalFingerprints({ threadId: certThread })).length, 1);

  // B has observed the revocation of C's leaf: NEW admission must refuse,
  // whatever epoch the (validly signed) record claims.
  B.revocation.state = { revokedCertIds: [leaf.certId], minValidIssuedAtMs: 0 };
  await A.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();
  assert.equal((await B.app.bus.stores.threadStore.listOriginalFingerprints({ threadId: certThread })).length, 0,
    "the revoked device's fact is rejected at sibling admission");
});

test("re-transfer is idempotent and converged siblings exchange digests in silence", async () => {
  const { network, bob, A, B } = await setupPair();
  await deliverLive(A, signedBaseFact(bob, { messageId: "m1", text: "one" }));
  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();
  assert.deepEqual(await fingerprintsOf(B), await fingerprintsOf(A));
  const rowsBefore = (await messagesOf(B)).length;
  const factsBefore = (await fingerprintsOf(B)).length;

  // Converged: another full round produces digest traffic ONLY.
  network.opLog.length = 0;
  await A.app.bus.services.siblingSync.syncAll({ force: true });
  await B.app.bus.services.siblingSync.syncAll({ force: true });
  await network.drain();
  assert.ok(network.opLog.length > 0, "digests are exchanged");
  assert.deepEqual([...new Set(network.opLog)], ["digest"], "no inventory/transfer once converged");
  assert.equal((await messagesOf(B)).length, rowsBefore, "no duplicate rows");
  assert.equal((await fingerprintsOf(B)).length, factsBefore, "no duplicate facts");
});
