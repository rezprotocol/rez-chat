// AE-1 fact layer (plans/ORIGINAL_MESSAGE_ANTIENTROPY_PLAN.md): the
// immutable per-thread OriginalMessage log in ChatThreadStore — append-only,
// fingerprint-keyed, idempotent — and the FROZEN conflict semantic at the
// projection upsert seam: same sender + same messageId + different signed
// content is an integrity conflict; both facts stay, no winner is chosen,
// the projection row is flagged `conflicted`.

import test from "node:test";
import assert from "node:assert/strict";

import { ThreadStoreService } from "../src/server/storage/ChatThreadStore.js";
import { MESSAGE_KIND } from "../src/records/payloads/ChatMessagePayloadV1.js";
import { MESSAGE_EDIT_KIND } from "../src/records/payloads/ChatMessageEditPayloadV1.js";

class MemoryKV {
  constructor() {
    this._data = new Map();
    this._failSetIncludes = "";
  }

  async get(key) {
    return this._data.get(key) || null;
  }

  async set(key, value) {
    if (this._failSetIncludes && String(key).includes(this._failSetIncludes)) {
      this._failSetIncludes = "";
      throw new Error("injected set failure");
    }
    this._data.set(key, value);
  }

  failNextSetIncluding(fragment) {
    this._failSetIncludes = String(fragment || "");
  }

  async delete(key) {
    this._data.delete(key);
  }

  async keys(prefix) {
    const out = [];
    for (const key of this._data.keys()) {
      if (String(key).startsWith(prefix)) out.push(key);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }
}

class MemoryStorageProvider {
  constructor() {
    this._kv = new MemoryKV();
  }

  getKeyValueStore() {
    return this._kv;
  }
}

const OWNER = "acct_owner";
const PEER = "acct_peer";
const THREAD = "th_facts";
let NOW = 1756000000000;

async function makeStore(storageProvider = new MemoryStorageProvider()) {
  const store = new ThreadStoreService({
    storageProvider,
    ownerAccountId: OWNER,
    clock: () => NOW,
  });
  await store.ensureThread({
    threadId: THREAD,
    threadType: "direct",
    peerAccountId: PEER,
    peerInboxId: "inbox_peer",
    createdAtMs: NOW,
  });
  return store;
}

function signedBasePayload({ sender = PEER, messageId = "m1", text = "hello", contentHash }) {
  return {
    kind: MESSAGE_KIND,
    threadId: THREAD,
    senderAccountId: sender,
    messageId,
    text,
    signerPublicKeyB64: "signerB64",
    senderDeviceId: "",
    senderAuthorityEpoch: 1,
    senderCertChain: [],
    contentHash,
    sig: "sigB64",
  };
}

test("appendOriginalFact: append-only, fingerprint-idempotent", async () => {
  const store = await makeStore();
  const payload = signedBasePayload({ contentHash: "fp_a" });

  const first = await store.appendOriginalFact({ threadId: THREAD, fact: { fingerprint: "fp_a", payload, origin: "live" } });
  assert.equal(first.appended, true);
  assert.equal(first.conflict, null);

  const replay = await store.appendOriginalFact({ threadId: THREAD, fact: { fingerprint: "fp_a", payload, origin: "sync" } });
  assert.equal(replay.appended, false, "re-appending an existing fingerprint is a no-op");
  assert.equal(replay.conflict, null);

  const fact = await store.getOriginalFact({ threadId: THREAD, fingerprint: "fp_a" });
  assert.equal(fact.kind, MESSAGE_KIND);
  assert.equal(fact.senderAccountId, PEER);
  assert.equal(fact.messageId, "m1");
  assert.equal(fact.origin, "live", "the original admission origin is preserved on replay");

  assert.deepEqual(await store.listOriginalFingerprints({ threadId: THREAD }), ["fp_a"]);
});

test("appendOriginalFact repairs a derived-index write that failed after the fact committed", async () => {
  const storageProvider = new MemoryStorageProvider();
  const store = await makeStore(storageProvider);
  const payload = signedBasePayload({ contentHash: "fp_repair" });
  storageProvider._kv.failNextSetIncluding("app:originals_index/");

  await assert.rejects(
    store.appendOriginalFact({ threadId: THREAD, fact: { fingerprint: "fp_repair", payload, origin: "local" } }),
    /injected set failure/,
  );
  assert.notEqual(
    await store.getOriginalFact({ threadId: THREAD, fingerprint: "fp_repair" }),
    null,
    "the authoritative fact committed before the derived index fault",
  );
  assert.equal(
    (await store.findBaseFactsByMessageId({ threadId: THREAD, messageId: "m1", senderAccountId: PEER })).length,
    0,
    "the injected fault reproduced the missing derived index",
  );

  const retry = await store.appendOriginalFact({
    threadId: THREAD,
    fact: { fingerprint: "fp_repair", payload, origin: "local" },
  });
  assert.equal(retry.appended, false, "the fact remains append-only on repair");
  assert.equal(retry.conflict, null);
  const repaired = await store.findBaseFactsByMessageId({ threadId: THREAD, messageId: "m1", senderAccountId: PEER });
  assert.deepEqual(repaired.map((fact) => fact.fingerprint), ["fp_repair"]);
});

test("second fingerprint under one (sender, messageId) identity = integrity conflict, both facts retained", async () => {
  const store = await makeStore();
  await store.appendOriginalFact({
    threadId: THREAD,
    fact: { fingerprint: "fp_a", payload: signedBasePayload({ text: "version A", contentHash: "fp_a" }) },
  });
  const second = await store.appendOriginalFact({
    threadId: THREAD,
    fact: { fingerprint: "fp_b", payload: signedBasePayload({ text: "version B", contentHash: "fp_b" }) },
  });
  assert.equal(second.appended, true, "the conflicting fact is RETAINED, never rejected");
  assert.ok(second.conflict, "the conflict is reported");
  assert.equal(second.conflict.senderAccountId, PEER);
  assert.equal(second.conflict.messageId, "m1");
  assert.deepEqual([...second.conflict.fingerprints].sort(), ["fp_a", "fp_b"]);

  // Both facts are readable — no winner was chosen, nothing was overwritten.
  assert.equal((await store.getOriginalFact({ threadId: THREAD, fingerprint: "fp_a" })).payload.text, "version A");
  assert.equal((await store.getOriginalFact({ threadId: THREAD, fingerprint: "fp_b" })).payload.text, "version B");
  assert.deepEqual(await store.listOriginalFingerprints({ threadId: THREAD }), ["fp_a", "fp_b"]);

  const facts = await store.findBaseFactsByMessageId({ threadId: THREAD, messageId: "m1" });
  assert.equal(facts.length, 2);
  const filtered = await store.findBaseFactsByMessageId({ threadId: THREAD, messageId: "m1", senderAccountId: "acct_other" });
  assert.equal(filtered.length, 0);
});

test("different senders sharing a messageId is NOT a conflict (TRUST-1 territory, distinct identities)", async () => {
  const store = await makeStore();
  await store.appendOriginalFact({
    threadId: THREAD,
    fact: { fingerprint: "fp_a", payload: signedBasePayload({ sender: PEER, contentHash: "fp_a" }) },
  });
  const other = await store.appendOriginalFact({
    threadId: THREAD,
    fact: { fingerprint: "fp_c", payload: signedBasePayload({ sender: "acct_third", contentHash: "fp_c" }) },
  });
  assert.equal(other.appended, true);
  assert.equal(other.conflict, null, "cross-sender id sharing is disambiguated identity, not integrity conflict");

  const ofPeer = await store.findBaseFactsByMessageId({ threadId: THREAD, messageId: "m1", senderAccountId: PEER });
  assert.equal(ofPeer.length, 1);
  assert.equal(ofPeer[0].fingerprint, "fp_a");
});

test("mutation facts join the log but never the base-identity index", async () => {
  const store = await makeStore();
  await store.appendOriginalFact({
    threadId: THREAD,
    fact: { fingerprint: "fp_a", payload: signedBasePayload({ contentHash: "fp_a" }) },
  });
  const editPayload = {
    kind: MESSAGE_EDIT_KIND,
    threadId: THREAD,
    senderAccountId: PEER,
    targetMessageId: "m1",
    targetFingerprint: "fp_a",
    newText: "edited",
    editedAtMs: NOW,
    signerPublicKeyB64: "signerB64",
    senderAuthorityEpoch: 1,
    contentHash: "fp_edit",
    sig: "sigB64",
  };
  const appended = await store.appendOriginalFact({ threadId: THREAD, fact: { fingerprint: "fp_edit", payload: editPayload } });
  assert.equal(appended.appended, true);
  assert.equal(appended.conflict, null);

  const fact = await store.getOriginalFact({ threadId: THREAD, fingerprint: "fp_edit" });
  assert.equal(fact.targetMessageId, "m1");
  assert.equal(fact.targetFingerprint, "fp_a", "the mutation's authoritative edge is the target fingerprint");

  // The base index still resolves exactly ONE base fact for m1 — mutations
  // do not pollute base identity.
  const facts = await store.findBaseFactsByMessageId({ threadId: THREAD, messageId: "m1" });
  assert.equal(facts.length, 1);
  assert.deepEqual(await store.listOriginalFingerprints({ threadId: THREAD }), ["fp_a", "fp_edit"]);
});

test("upsert seam: same-sender signed redelivery collapses; DIFFERENT signed content flags conflicted", async () => {
  const store = await makeStore();
  const payloadA = signedBasePayload({ text: "version A", contentHash: "fp_a" });
  const first = await store.upsertDepositedMessage({
    messageId: "m1",
    threadId: THREAD,
    senderKey: PEER,
    senderAccountId: PEER,
    packetB64: "pkt",
    acceptedAtMs: NOW,
    text: "version A",
    payload: payloadA,
  });
  assert.equal(first.inserted, true);

  // Genuine idempotent redelivery (same fingerprint) collapses, unflagged.
  const redelivery = await store.upsertDepositedMessage({
    messageId: "m1",
    threadId: THREAD,
    senderKey: PEER,
    senderAccountId: PEER,
    packetB64: "pkt",
    acceptedAtMs: NOW + 1,
    text: "version A",
    payload: payloadA,
  });
  assert.equal(redelivery.inserted, false);
  assert.notEqual(redelivery.conflict, true);
  assert.notEqual(redelivery.message.conflicted, true);

  // Same sender, same id, DIFFERENT signed content: the frozen conflict.
  const conflicting = await store.upsertDepositedMessage({
    messageId: "m1",
    threadId: THREAD,
    senderKey: PEER,
    senderAccountId: PEER,
    packetB64: "pkt2",
    acceptedAtMs: NOW + 2,
    text: "version B",
    payload: signedBasePayload({ text: "version B", contentHash: "fp_b" }),
  });
  assert.equal(conflicting.inserted, false, "the conflicting content never silently replaces the row");
  assert.equal(conflicting.conflict, true);
  assert.equal(conflicting.message.conflicted, true);
  // NO winner: the row keeps the first-stored text only as the carrier of
  // the flag — it is marked, not endorsed.
  const listed = await store.listMessages({ threadId: THREAD });
  const row = listed.items.find((m) => m.messageId === "m1");
  assert.equal(row.conflicted, true);
});

test("upsert seam: unsigned rows keep the pre-AE-1 collapse (no fingerprint to distinguish by)", async () => {
  const store = await makeStore();
  const unsigned = {
    kind: MESSAGE_KIND, threadId: THREAD, senderAccountId: PEER, messageId: "m1", text: "legacy",
  };
  await store.upsertDepositedMessage({
    messageId: "m1", threadId: THREAD, senderKey: PEER, senderAccountId: PEER,
    packetB64: "pkt", acceptedAtMs: NOW, text: "legacy", payload: unsigned,
  });
  // Signed arrival colliding with an UNSIGNED row: collapse, not conflict —
  // the unsigned era cannot participate in fingerprint semantics.
  const collided = await store.upsertDepositedMessage({
    messageId: "m1", threadId: THREAD, senderKey: PEER, senderAccountId: PEER,
    packetB64: "pkt2", acceptedAtMs: NOW + 1, text: "signed",
    payload: signedBasePayload({ text: "signed", contentHash: "fp_x" }),
  });
  assert.equal(collided.inserted, false);
  assert.notEqual(collided.conflict, true);
  assert.notEqual(collided.message.conflicted, true);
});

test("markMessageConflicted flags the projection row idempotently; absent rows return null", async () => {
  const store = await makeStore();
  await store.upsertDepositedMessage({
    messageId: "m1", threadId: THREAD, senderKey: PEER, senderAccountId: PEER,
    packetB64: "pkt", acceptedAtMs: NOW, text: "hello",
    payload: signedBasePayload({ contentHash: "fp_a" }),
  });
  const flagged = await store.markMessageConflicted({ threadId: THREAD, messageId: "m1" });
  assert.equal(flagged.conflicted, true);
  const again = await store.markMessageConflicted({ threadId: THREAD, messageId: "m1" });
  assert.equal(again.conflicted, true);
  assert.equal(await store.markMessageConflicted({ threadId: THREAD, messageId: "missing" }), null);

  // The flag survives the store round-trip.
  const listed = await store.listMessages({ threadId: THREAD });
  assert.equal(listed.items.find((m) => m.messageId === "m1").conflicted, true);
});

test("fact log rows survive independent of the projection's 500-row cap semantics", async () => {
  // The projection bounds rows per thread; the immutable log must not — a
  // fact appended is a fact retained (append-only truth for AE-2).
  const store = await makeStore();
  for (let i = 0; i < 5; i++) {
    const fp = "fp_" + String(i).padStart(3, "0");
    await store.appendOriginalFact({
      threadId: THREAD,
      fact: { fingerprint: fp, payload: signedBasePayload({ messageId: "m" + i, contentHash: fp }) },
    });
  }
  const fingerprints = await store.listOriginalFingerprints({ threadId: THREAD });
  assert.equal(fingerprints.length, 5);
  assert.deepEqual(fingerprints, [...fingerprints].sort(), "inventory listing is sorted (digest seam)");
});

// ── AE-1 close ruling: the cutover signing boundary ─────────────────────────
// SIGNING_UNAVAILABLE_BY_CONFIGURATION (no signer machinery at all) → legacy
// unsigned emission. SIGNING_EXPECTED_BUT_BROKEN (machinery present, signer
// fails) → the send FAILS — a full runtime must never quietly leave
// authenticated history through an error path.

import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { bytesToBase64, deriveAccountIdFromPublicKey } from "@rezprotocol/sdk/client";
import { NodeCryptoProvider } from "@rezprotocol/node";

const CRYPTO = new NodeCryptoProvider();
const FAKE_KEYS = {
  publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  privateKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

class AppKV {
  constructor() { this._data = new Map(); }
  async get(key) { return this._data.get(key); }
  async set(key, value) { this._data.set(key, value); }
  async delete(key) { this._data.delete(key); }
  async keys(prefix) {
    const out = [];
    for (const k of this._data.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}
class AppStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new AppKV());
    return this._stores.get(name);
  }
}

// A non-`th_` thread id keeps sendMessage off the mesh-delivery path (no sdk
// in these tests) while still exercising build/sign/persist.
const LOCAL_THREAD = "t_signing_boundary";

async function makeApp() {
  const rootKp = CRYPTO.generateSigningKeyPair();
  const ownerAccountId = deriveAccountIdFromPublicKey(rootKp.publicKey);
  const app = new ChatServerApp({
    identity: { ...FAKE_KEYS, accountId: ownerAccountId, deviceId: "dev:x" },
    uplinks: ["ws://localhost:9999"],
    storageProvider: new AppStorageProvider(),
    ownerAccountId,
    clock: () => Date.now(),
  });
  await app.bus.services.threads.ensureDirectThread({
    threadId: LOCAL_THREAD, peerAccountId: "rez:acct:peer", peerInboxId: "inbox:peer", createdAtMs: 1000,
  });
  return { app, rootKp, ownerAccountId };
}

async function sentRow(app, messageId) {
  const page = await app.bus.stores.threadStore.listMessages({ threadId: LOCAL_THREAD, limit: 50 });
  return (page.items || []).find((m) => m.messageId === messageId) || null;
}

test("no signer machinery at all (by configuration) → legacy unsigned emission", async () => {
  const { app } = await makeApp();
  // bus.runtime has no peerLinks — a minimal embedding.
  const result = await app.bus.services.messages.sendMessage({
    threadId: LOCAL_THREAD, payload: { kind: MESSAGE_KIND, text: "plain old message" }, messageId: "m_unsigned",
  });
  assert.equal(result.messageId, "m_unsigned");
  const row = await sentRow(app, "m_unsigned");
  assert.ok(row, "the message persisted");
  assert.ok(!row.payload.sig, "no signature — legacy unsigned payload");
  const facts = await app.bus.stores.threadStore.listOriginalFingerprints({ threadId: LOCAL_THREAD });
  assert.equal(facts.length, 0, "unsigned messages are not facts");
});

test("signer machinery present but broken → the send FAILS (never a silent unsigned downgrade), and recovers", async () => {
  const { app, rootKp, ownerAccountId } = await makeApp();
  let broken = true;
  const signerPublicKeyB64 = bytesToBase64(rootKp.publicKey);
  app.bus.runtime.peerLinks = {
    async accountAuthoritySigner() {
      if (broken) throw new Error("keystore locked");
      return {
        mode: "direct",
        signerPublicKeyB64,
        senderDeviceId: null,
        certChain: null,
        sign: async (bytes) => CRYPTO.sign({ privateKey: rootKp.privateKey, msg: bytes }),
      };
    },
  };

  await assert.rejects(
    app.bus.services.messages.sendMessage({ threadId: LOCAL_THREAD, payload: { kind: MESSAGE_KIND, text: "must not go unsigned" }, messageId: "m_broken" }),
    (err) => err.code === "SIGNING_EXPECTED_BUT_BROKEN",
    "an expected-but-broken signer fails the send",
  );
  assert.equal(await sentRow(app, "m_broken"), null, "nothing was emitted unsigned");

  // A transient failure must not poison the runtime: fix the signer, retry.
  broken = false;
  const result = await app.bus.services.messages.sendMessage({
    threadId: LOCAL_THREAD, payload: { kind: MESSAGE_KIND, text: "now signed" }, messageId: "m_signed",
  });
  assert.equal(result.messageId, "m_signed");
  const row = await sentRow(app, "m_signed");
  assert.ok(row.payload.sig, "the retry produced a SIGNED OriginalMessage");
  assert.equal(row.payload.senderAccountId, ownerAccountId);
  const facts = await app.bus.stores.threadStore.listOriginalFingerprints({ threadId: LOCAL_THREAD });
  assert.deepEqual(facts, [row.payload.contentHash], "the signed fact entered the immutable log (origin local)");
});
