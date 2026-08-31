// MessageCommitAck end-to-end (plans/MESSAGE_COMMIT_ACK_PLAN.md §5): two REAL
// ChatServerApps (sender Alice, recipient Bob — distinct accounts with real
// NodeCryptoProvider keys) over a loopback of the sealed peer channel. Under
// test: the frozen emission order (ack only after admission + fact append +
// projection commit), the hard cutover by message regime (signed →
// MessageCommitAckV1 only; unsigned → legacy delivery ack byte-identically),
// fail-closed sender acceptance (wrong fingerprint / revoked signer /
// unavailable revocation source), the durable pending-commit retry loop
// (exact-same-fact re-fan-out, restart survival), path-independent proof
// (decision 2: any verified ack for the fingerprint terminates), and the
// legacy-ack guard (a signed row never flips "delivered" without proof).

import test from "node:test";
import assert from "node:assert/strict";

import { bytesToBase64, deriveAccountIdFromPublicKey } from "@rezprotocol/sdk/client";
import { NodeCryptoProvider } from "@rezprotocol/node";
import {
  AccountDeviceCapabilityV1,
  ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
  DeviceRegistrationV1,
} from "@rezprotocol/core";

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { MESSAGE_KIND } from "../src/records/payloads/ChatMessagePayloadV1.js";
import { MessageCommitAckV1, MESSAGE_COMMIT_ACK_KIND } from "../src/records/payloads/MessageCommitAckV1.js";

const CRYPTO = new NodeCryptoProvider();
const FAKE_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const THREAD = "th_ab";

class AppKV {
  constructor() { this._data = new Map(); this._failSetIncludes = ""; }
  async get(key) { return this._data.get(key); }
  async set(key, value) {
    if (this._failSetIncludes && String(key).includes(this._failSetIncludes)) {
      this._failSetIncludes = "";
      throw new Error("injected set failure");
    }
    this._data.set(key, value);
  }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
  failNextSetIncluding(fragment) { this._failSetIncludes = String(fragment || ""); }
}
class AppStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new AppKV());
    return this._stores.get(name);
  }
}

function makeAccount() {
  const keyPair = CRYPTO.generateSigningKeyPair();
  return {
    keyPair,
    pubB64: bytesToBase64(keyPair.publicKey),
    accountId: deriveAccountIdFromPublicKey(keyPair.publicKey),
  };
}

// The loopback sealed channel: every sealForPeer→dispatch lands here with
// the DISPATCHING app's account as the envelope-authenticated sender (what
// the real peer-link decrypt would attest). drain() applies frames through
// the real ingest seam; wireLog records every frame's decoded kind.
class Loopback {
  constructor() {
    this.routes = new Map();
    this.queue = [];
    this.wireLog = [];
    this.eventSeq = 0;
  }
  register(inboxId, app) { this.routes.set(inboxId, app); }
  push(frame) {
    const json = JSON.parse(new TextDecoder().decode(frame.plaintextBodyBytes));
    this.wireLog.push({ kind: json.kind, toInbox: frame.deliverInboxId, json });
    this.queue.push(frame);
  }
  // Ack emission is fire-and-forget at the T1 site, so a frame's follow-up
  // (the commit/legacy ack) lands in the queue a few promise turns AFTER
  // applyUserMessage resolves — keep pumping until the network is quiet.
  async drain() {
    let idle = 0;
    while (idle < 10) {
      if (this.queue.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        idle += 1;
        continue;
      }
      idle = 0;
      const frame = this.queue.shift();
      const app = this.routes.get(frame.deliverInboxId);
      if (!app) continue;
      this.eventSeq += 1;
      await app.bus.services.events.applyUserMessage({
        eventId: "evt_" + this.eventSeq,
        mailboxId: frame.deliverInboxId,
        plaintextB64: Buffer.from(frame.plaintextBodyBytes).toString("base64"),
        senderAccountId: frame.fromAccountId,
      });
    }
  }
  kinds() { return this.wireLog.map((f) => f.kind); }
}

async function makeAppNode({ network, inboxId, ownAccount, peerAccount, peerInboxId, storageProvider, withSigner = true }) {
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: ownAccount.accountId, deviceId: "dev:" + inboxId },
    uplinks: ["ws://localhost:9999"],
    storageProvider: storageProvider || new AppStorageProvider(),
    ownerAccountId: ownAccount.accountId,
    clock: () => Date.now(),
  });
  const peerLinks = { cryptoProvider: CRYPTO };
  if (withSigner) {
    peerLinks.accountAuthoritySigner = async () => ({
      mode: "direct",
      signerPublicKeyB64: ownAccount.pubB64,
      senderDeviceId: "",
      certChain: null,
      sign: async (bytes) => CRYPTO.sign({ privateKey: ownAccount.keyPair.privateKey, msg: bytes }),
    });
  }
  const sdk = {
    getIdentity: () => ({ localInboxId: inboxId }),
    devices: { getAuthorityState: async () => ({ epoch: 0, revokedCertIds: [] }) },
    sealForPeer: async ({ peerAccountId, plaintextBodyBytes, deliverInboxId }) => ({
      object: { deliverInboxId, plaintextBodyBytes, fromAccountId: ownAccount.accountId, peerAccountId },
      address: deliverInboxId,
    }),
    mesh: { dispatch: async (object) => { network.push(object); return {}; } },
  };
  Object.assign(app.bus.runtime, { peerLinks, sdk });

  // The sender-side peer revocation source (cert-mode ack acceptance),
  // controllable per test. Default: established, nothing revoked.
  const node = { app, inboxId, account: ownAccount, revocation: { enabled: true, error: null, state: null } };
  app.bus.services.accountMutation = {
    isEnabled: () => node.revocation.enabled,
    getPeerRevocationState: async () => {
      if (node.revocation.error) throw node.revocation.error;
      return node.revocation.state;
    },
  };

  await app.bus.services.threads.ensureDirectThread({
    threadId: THREAD,
    peerAccountId: peerAccount.accountId,
    peerInboxId,
    createdAtMs: 1000,
  });
  network.register(inboxId, app);
  return node;
}

async function setupPair({ aliceSigner = true, bobSigner = true, aliceStorage } = {}) {
  const network = new Loopback();
  const aliceAccount = makeAccount();
  const bobAccount = makeAccount();
  const alice = await makeAppNode({
    network, inboxId: "inbox:alice", ownAccount: aliceAccount,
    peerAccount: bobAccount, peerInboxId: "inbox:bob",
    storageProvider: aliceStorage, withSigner: aliceSigner,
  });
  const bob = await makeAppNode({
    network, inboxId: "inbox:bob", ownAccount: bobAccount,
    peerAccount: aliceAccount, peerInboxId: "inbox:alice",
    withSigner: bobSigner,
  });
  return { network, alice, bob, aliceAccount, bobAccount };
}

async function teardown(...nodes) {
  for (const node of nodes) {
    await node.app.bus.services.messages.stop();
  }
}

async function rowOf(node, messageId) {
  const page = await node.app.bus.stores.threadStore.listMessages({ threadId: THREAD, limit: 50 });
  return (page.items || []).find((m) => m.messageId === messageId) || null;
}

async function pendingOf(node) {
  return node.app.bus.stores.threadStore.listPendingCommits();
}

async function sendSigned(node, { messageId, text }) {
  return node.app.bus.services.messages.sendMessage({
    threadId: THREAD,
    payload: { kind: MESSAGE_KIND, text },
    messageId,
  });
}

// Hand-build a commit ack signed by an account root (the shape any recipient
// device of that account — original target or anti-entropy sibling — emits).
function ackFromAccount(account, { messageId, messageFingerprint, threadId = THREAD, committedAtMs = Date.now() }) {
  const semantic = {
    messageId,
    messageFingerprint,
    threadId,
    recipientAccountId: account.accountId,
    recipientDeviceId: "",
    recipientAuthorityEpoch: 0,
    signerPublicKeyB64: account.pubB64,
    committedAtMs,
  };
  const sig = CRYPTO.sign({ privateKey: account.keyPair.privateKey, msg: MessageCommitAckV1.signableBytes(semantic) });
  return new MessageCommitAckV1({ ...semantic, recipientCertChain: [], sig: bytesToBase64(sig) }).toJSON();
}

test("normal delivery: signed send → admitted commit → verified MessageCommitAck → delivered; no legacy ack for the signed regime", async (t) => {
  const { network, alice, bob } = await setupPair();
  t.after(() => teardown(alice, bob));
  await sendSigned(alice, { messageId: "m1", text: "hello bob" });

  assert.equal((await pendingOf(alice)).length, 1, "the signed send opened a durable pending-commit row");
  assert.equal((await rowOf(alice, "m1")).status, "sent");

  await network.drain(); // message → bob (admit + commit + ack), ack → alice

  const kinds = network.kinds();
  assert.ok(kinds.includes(MESSAGE_COMMIT_ACK_KIND), "the commit ack crossed the wire");
  assert.ok(!kinds.includes("rez.delivery.ack"), "hard cutover: no legacy ack for a signed message");

  const bobFacts = await bob.app.bus.stores.threadStore.listOriginalFingerprints({ threadId: THREAD });
  assert.equal(bobFacts.length, 1, "bob admitted the fact before acking");
  const ackFrame = network.wireLog.find((f) => f.kind === MESSAGE_COMMIT_ACK_KIND);
  assert.equal(ackFrame.json.messageFingerprint, bobFacts[0], "the ack claims the admitted fingerprint");

  assert.equal((await rowOf(alice, "m1")).status, "delivered", "verified proof drives the delivered status");
  assert.equal((await pendingOf(alice)).length, 0, "the pending commit was consumed");

  // Idempotent duplicate resend: the same fact re-applied at bob re-emits the
  // ack; alice consumes the duplicate proof harmlessly.
  await bob.app.bus.services.events.applyUserMessage({
    eventId: "evt_dup",
    mailboxId: "inbox:bob",
    plaintextB64: Buffer.from(JSON.stringify((await rowOf(alice, "m1")).payload)).toString("base64"),
    senderAccountId: alice.account.accountId,
  });
  await network.drain();
  assert.equal(network.kinds().filter((k) => k === MESSAGE_COMMIT_ACK_KIND).length, 2, "the duplicate re-emitted the ack");
  assert.equal((await rowOf(alice, "m1")).status, "delivered", "duplicate proof is a harmless no-op");
  assert.equal((await pendingOf(alice)).length, 0);
});

test("a commit ack delivered before dispatch resolves consumes the pre-opened intent without leaving an immortal retry", async (t) => {
  const { network, alice, bob } = await setupPair();
  t.after(() => teardown(alice, bob));
  alice.app.bus.runtime.sdk.mesh.dispatch = async (object) => {
    network.push(object);
    await network.drain();
    return {};
  };

  await sendSigned(alice, { messageId: "m_sync_ack", text: "ack inside dispatch" });

  assert.equal((await rowOf(alice, "m_sync_ack")).status, "delivered");
  assert.equal((await pendingOf(alice)).length, 0, "the synchronously consumed intent is never recreated after dispatch");
  assert.equal(network.kinds().filter((kind) => kind === MESSAGE_COMMIT_ACK_KIND).length, 1);
});

test("a local signed-fact persistence fault fails before external dispatch and repairs cleanly on retry", async (t) => {
  const storage = new AppStorageProvider();
  const { network, alice, bob } = await setupPair({ aliceStorage: storage });
  t.after(() => teardown(alice, bob));
  storage.getKeyValueStore(alice.account.accountId).failNextSetIncluding("app:originals_index/");

  await assert.rejects(
    sendSigned(alice, { messageId: "m_fact_fault", text: "must stay local" }),
    /injected set failure/,
  );
  assert.equal(network.wireLog.length, 0, "nothing crossed the transport without durable fact state");
  assert.equal((await pendingOf(alice)).length, 0, "retry intent is not opened until fact persistence succeeds");

  await sendSigned(alice, { messageId: "m_fact_fault", text: "must stay local" });
  assert.equal(network.wireLog.length, 1, "retry repaired the index and dispatched exactly once");
  assert.equal((await pendingOf(alice)).length, 1);
});

test("no commit → the retry loop re-fans-out the EXACT same OriginalMessage and the row survives", async (t) => {
  const { network, alice, bob } = await setupPair();
  t.after(() => teardown(alice, bob));
  await sendSigned(alice, { messageId: "m1", text: "into the void" });
  const sentFingerprint = (await pendingOf(alice))[0].fingerprint;
  network.queue.length = 0; // provider accepted, recipient never saw it

  const result = await alice.app.bus.services.messages.sweepPendingCommits({ force: true });
  assert.equal(result.swept, 1);
  const rows = await pendingOf(alice);
  assert.equal(rows.length, 1, "no ack → the row stays pending (never time-based failure)");
  assert.equal(rows[0].attempts, 1);
  assert.ok(rows[0].nextRetryAtMs > rows[0].lastAttemptAtMs, "the next window is scheduled");

  const resend = network.wireLog[network.wireLog.length - 1];
  assert.equal(resend.json.kind, MESSAGE_KIND, "the retry re-sent the message");
  assert.equal(resend.json.contentHash, sentFingerprint, "same fingerprint — never a new message id or content");
  assert.equal(resend.json.messageId, "m1");

  // The re-sent copy now reaches bob: the loop terminates on the ack.
  await network.drain();
  assert.equal((await rowOf(alice, "m1")).status, "delivered");
  assert.equal((await pendingOf(alice)).length, 0);
});

test("a wrong-fingerprint ack is divergence evidence — ignored, retry stays armed", async (t) => {
  const { network, alice, bob, bobAccount } = await setupPair();
  t.after(() => teardown(alice, bob));
  await sendSigned(alice, { messageId: "m1", text: "real content" });
  network.queue.length = 0;

  const forged = ackFromAccount(bobAccount, { messageId: "m1", messageFingerprint: "0".repeat(64) });
  network.push({ deliverInboxId: "inbox:alice", plaintextBodyBytes: new TextEncoder().encode(JSON.stringify(forged)), fromAccountId: bobAccount.accountId });
  await network.drain();

  assert.equal((await rowOf(alice, "m1")).status, "sent", "wrong claim never flips the status");
  assert.equal((await pendingOf(alice)).length, 1, "the pending commit is untouched");
});

test("cert-mode acks: revoked signer rejected; unavailable revocation source leaves the ack unconsumed; established source consumes", async (t) => {
  const { network, alice, bob, bobAccount } = await setupPair();
  t.after(() => teardown(alice, bob));
  await sendSigned(alice, { messageId: "m1", text: "needs proof" });
  network.queue.length = 0;
  const fingerprint = (await pendingOf(alice))[0].fingerprint;

  // Bob's delegated device signs the ack under a capability chain.
  const deviceKp = CRYPTO.generateSigningKeyPair();
  const devicePubB64 = bytesToBase64(deviceKp.publicKey);
  const now = Date.now();
  const fields = {
    v: 1,
    purpose: ACCOUNT_DEVICE_CAPABILITY_PURPOSE,
    accountIdentityPublicKeyB64: bobAccount.pubB64,
    parentCertId: null,
    granteeDevicePublicKeyB64: devicePubB64,
    granteeDeviceId: DeviceRegistrationV1.deviceIdFor(devicePubB64),
    capabilities: ["peerLink.create"],
    maxDelegationDepth: 0,
    issuedAtMs: now - 2000,
    expiresAtMs: now + 86400000,
    signerPublicKeyB64: bobAccount.pubB64,
  };
  const certId = AccountDeviceCapabilityV1.deriveCertId(fields);
  const certSig = CRYPTO.sign({ privateKey: bobAccount.keyPair.privateKey, msg: AccountDeviceCapabilityV1.signableBytes({ ...fields, certId }) });
  const leaf = new AccountDeviceCapabilityV1({ ...fields, certId, sig: { alg: "ed25519", sigB64: bytesToBase64(certSig) } }).toJSON();
  const semantic = {
    messageId: "m1",
    messageFingerprint: fingerprint,
    threadId: THREAD,
    recipientAccountId: bobAccount.accountId,
    recipientDeviceId: fields.granteeDeviceId,
    recipientAuthorityEpoch: 1,
    signerPublicKeyB64: devicePubB64,
    committedAtMs: now,
  };
  const ackSig = CRYPTO.sign({ privateKey: deviceKp.privateKey, msg: MessageCommitAckV1.signableBytes(semantic) });
  const certAck = new MessageCommitAckV1({ ...semantic, recipientCertChain: [leaf], sig: bytesToBase64(ackSig) }).toJSON();
  const deliverAck = async () => {
    network.push({ deliverInboxId: "inbox:alice", plaintextBodyBytes: new TextEncoder().encode(JSON.stringify(certAck)), fromAccountId: bobAccount.accountId });
    await network.drain();
  };

  // Revocation source UNAVAILABLE → the ack is left unconsumed (defer, never
  // "unknown authority state means probably okay").
  alice.revocation.enabled = false;
  await deliverAck();
  assert.equal((await rowOf(alice, "m1")).status, "sent");
  assert.equal((await pendingOf(alice)).length, 1, "unavailable source leaves the pending commit armed");

  // Source established and the device is REVOKED → rejected.
  alice.revocation.enabled = true;
  alice.revocation.state = { revokedCertIds: [leaf.certId], minValidIssuedAtMs: 0 };
  await deliverAck();
  assert.equal((await rowOf(alice, "m1")).status, "sent", "a revoked device's ack proves nothing");
  assert.equal((await pendingOf(alice)).length, 1);

  // Source established, nothing revoked → the same ack consumes.
  alice.revocation.state = null;
  await deliverAck();
  assert.equal((await rowOf(alice, "m1")).status, "delivered");
  assert.equal((await pendingOf(alice)).length, 0);
});

test("a valid ack terminates the retry regardless of which recipient device/path produced it (sibling semantics)", async (t) => {
  const { network, alice, bob, bobAccount } = await setupPair();
  t.after(() => teardown(alice, bob));
  await sendSigned(alice, { messageId: "m1", text: "sibling will prove this" });
  network.queue.length = 0; // the original fan-out target never acks
  const fingerprint = (await pendingOf(alice))[0].fingerprint;

  // A device outside the original target set (e.g. a sibling that converged
  // via anti-entropy) makes the same account-level claim. Its verified ack
  // is the same terminal condition — idempotent by fingerprint.
  const siblingAck = ackFromAccount(bobAccount, { messageId: "m1", messageFingerprint: fingerprint });
  network.push({ deliverInboxId: "inbox:alice", plaintextBodyBytes: new TextEncoder().encode(JSON.stringify(siblingAck)), fromAccountId: bobAccount.accountId });
  await network.drain();

  assert.equal((await rowOf(alice, "m1")).status, "delivered", "the sender cares about account-level commit, not transport provenance");
  assert.equal((await pendingOf(alice)).length, 0);
});

test("a legacy delivery ack never flips a signed send to delivered (proof-backed status)", async (t) => {
  const { network, alice, bob } = await setupPair();
  t.after(() => teardown(alice, bob));
  await sendSigned(alice, { messageId: "m1", text: "signed regime" });
  network.queue.length = 0;

  await alice.app.bus.services.messages.handleDeliveryAck({ threadId: THREAD, messageIds: ["m1"] });
  assert.equal((await rowOf(alice, "m1")).status, "sent", "the legacy ack is transport evidence, not commit proof");
  assert.equal((await pendingOf(alice)).length, 1, "the retry loop keeps running until real proof arrives");
});

test("the unsigned legacy regime is unchanged: no fact, no pending commit, legacy delivery ack emitted", async (t) => {
  const { network, alice, bob } = await setupPair({ aliceSigner: false });
  t.after(() => teardown(alice, bob));
  await sendSigned(alice, { messageId: "m1", text: "legacy unsigned" });
  assert.equal((await pendingOf(alice)).length, 0, "unsigned sends never open a pending commit");

  await network.drain();
  const kinds = network.kinds();
  assert.ok(kinds.includes("rez.delivery.ack"), "the unsigned regime keeps the legacy delivery ack");
  assert.ok(!kinds.includes(MESSAGE_COMMIT_ACK_KIND), "no commit claim exists for an unsigned message");
  assert.equal((await bob.app.bus.stores.threadStore.listOriginalFingerprints({ threadId: THREAD })).length, 0);
});

test("pending commits survive a sender restart: the durable row drives the resumed retry", async (t) => {
  const storage = new AppStorageProvider();
  const { network, alice, bob, aliceAccount, bobAccount } = await setupPair({ aliceStorage: storage });
  t.after(() => teardown(bob));
  await sendSigned(alice, { messageId: "m1", text: "outlives the process" });
  network.queue.length = 0;
  const before = await pendingOf(alice);
  assert.equal(before.length, 1);
  await teardown(alice);

  // "Restart": a new app over the SAME storage. The row is already there;
  // a sweep (boot/reconnect trigger) re-fans-out from the immutable fact.
  const revived = await makeAppNode({
    network, inboxId: "inbox:alice", ownAccount: aliceAccount,
    peerAccount: bobAccount, peerInboxId: "inbox:bob", storageProvider: storage,
  });
  t.after(() => teardown(revived));
  const after = await pendingOf(revived);
  assert.equal(after.length, 1, "the pending row survived the restart");
  assert.equal(after[0].fingerprint, before[0].fingerprint);

  await revived.app.bus.services.messages.sweepPendingCommits({ force: true });
  const resend = network.wireLog[network.wireLog.length - 1];
  assert.equal(resend.json.messageId, "m1", "the revived sender re-fanned-out the same message");
  assert.equal(resend.json.contentHash, before[0].fingerprint, "same fact, same fingerprint");

  await network.drain(); // bob commits and acks; the revived sender consumes
  assert.equal((await pendingOf(revived)).length, 0, "the resumed loop terminated on the verified proof");
  assert.equal((await rowOf(revived, "m1")).status, "delivered");
});
