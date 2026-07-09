import test from "node:test";
import assert from "node:assert/strict";
import { ServerAccountStateSyncService } from "../src/server/services/ServerAccountStateSyncService.js";

function makeKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { return m.delete(k); },
    async keys(prefix) { const o = []; for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) o.push(k); return o; },
  };
}

function makeHarness({ deviceId = "rez:dev:self", siblings = [{ deviceId: "rez:dev:sib", inboxId: "inbox:sib" }], withSdk = true, kv = makeKv(), relationshipThrows = false, sigValid = true } = {}) {
  const calls = { dispatch: [], deposits: [], ensureActive: [], ensureKnown: [], deleteContact: [], ensureThread: [], upsertRelationship: [] };
  const sdk = withSdk ? {
    listSiblingDeviceInboxes: async () => siblings,
    buildAccountStateDeposit: async ({ deliverInboxId, plaintextBodyBytes }) => {
      calls.deposits.push({ deliverInboxId, event: JSON.parse(new TextDecoder().decode(plaintextBodyBytes)) });
      return { object: { payloadBytes: plaintextBodyBytes }, address: { inboxId: deliverInboxId } };
    },
    mesh: { dispatch: async (object, address) => { calls.dispatch.push({ object, address }); } },
  } : null;
  const contacts = {
    ensureActiveContact: async (a) => { calls.ensureActive.push(a); },
    ensureKnownAccount: async (a) => { calls.ensureKnown.push(a); },
    deleteContact: async (a) => { calls.deleteContact.push(a); },
  };
  const threads = {
    ensureDirectThread: async (a) => { calls.ensureThread.push(a); },
    directThreadIdForPeerLink: (plId, peer) => "th_" + plId,
  };
  const peerLinks = {
    deviceId,
    devicePublicKeyB64: "selfPubB64",
    signAccountStateEvent: async () => ({ originDeviceId: deviceId, originDevicePublicKeyB64: "selfPubB64", sigB64: "sig-" + deviceId }),
    verifyAccountStateEventSig: async () => sigValid,
    upsertPeerRelationship: async (a) => {
      calls.upsertRelationship.push(a);
      if (relationshipThrows) throw new Error("simulated relationship write fault");
    },
  };
  const bus = {
    runtime: { sdk, peerLinks, multiDeviceFanout: true },
    services: { contacts, threads },
    on() { return () => {}; }, emit() {}, registerFunction() {}, call() { return Promise.resolve(null); },
  };
  const svc = new ServerAccountStateSyncService({ bus, storageProvider: { getKeyValueStore: () => kv }, ownerAccountId: "rez:acct:alice", clock: () => 1000 });
  return { svc, calls, kv };
}

const CONTACT_UPSERT = {
  op: "contact.upsert",
  payload: {
    accountId: "rez:acct:carol", relationshipState: "active", displayName: "Carol",
    peerInboxId: "inbox:carol", peerLinkId: "pl_1", threadId: "th_carol",
    remoteAccountIdentityPublicKeyB64: "carolBpub", remoteIdentityDhPublicKeyB64: "carolDHpub",
  },
};

test("replicate fans a contact.upsert to sibling inboxes with a monotonic lamport", async () => {
  const { svc, calls } = makeHarness();
  const r1 = await svc.replicate(CONTACT_UPSERT);
  assert.equal(r1.fannedOut, 1);
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.deposits[0].deliverInboxId, "inbox:sib");
  assert.equal(calls.deposits[0].event.op, "contact.upsert");
  assert.equal(calls.deposits[0].event.originDeviceId, "rez:dev:self");
  assert.equal(calls.deposits[0].event.lamport, 1);

  const r2 = await svc.replicate(CONTACT_UPSERT);
  assert.equal(r2.fannedOut, 1);
  assert.equal(calls.deposits[1].event.lamport, 2, "lamport is monotonic across calls");
});

test("replicate is a no-op with no siblings and when the SDK is absent", async () => {
  const none = makeHarness({ siblings: [] });
  assert.deepEqual(await none.svc.replicate(CONTACT_UPSERT), { fannedOut: 0 });
  assert.equal(none.calls.dispatch.length, 0);

  const noSdk = makeHarness({ withSdk: false });
  assert.deepEqual(await noSdk.svc.replicate(CONTACT_UPSERT), { fannedOut: 0 });
});

test("applyInbound contact.upsert (active) makes the contact active, records the peer-link relationship, AND materializes the thread", async () => {
  const { svc, calls } = makeHarness();
  const res = await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 5, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.deepEqual(res, { applied: true });
  assert.equal(calls.ensureActive.length, 1);
  assert.equal(calls.ensureActive[0].accountId, "rez:acct:carol");
  // The peer-link relationship (identity + routing, no ratchet) is recorded so the
  // sibling can complete its own device session + reply.
  assert.equal(calls.upsertRelationship.length, 1);
  assert.equal(calls.upsertRelationship[0].peerAccountId, "rez:acct:carol");
  assert.equal(calls.upsertRelationship[0].peerLinkId, "pl_1");
  assert.equal(calls.upsertRelationship[0].remoteAccountIdentityPublicKeyB64, "carolBpub");
  assert.equal(calls.upsertRelationship[0].remoteIdentityDhPublicKeyB64, "carolDHpub");
  assert.equal(calls.ensureThread.length, 1);
  assert.equal(calls.ensureThread[0].threadId, "th_carol");
  assert.equal(calls.ensureThread[0].peerInboxId, "inbox:carol");
});

test("applyInbound skips the peer-link relationship when identity fields are absent (contact-only delta)", async () => {
  const { svc, calls } = makeHarness();
  await svc.applyInbound({ op: "contact.upsert", payload: { accountId: "rez:acct:carol", relationshipState: "active", displayName: "Carol" }, lamport: 2, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.equal(calls.ensureActive.length, 1);
  assert.equal(calls.upsertRelationship.length, 0);
  assert.equal(calls.ensureThread.length, 0, "no thread without peer-link fields");
});

test("AF1: a relationship-write failure aborts the apply — contact NOT activated, seen NOT advanced (retryable)", async () => {
  const kv = makeKv();
  const h = makeHarness({ kv, relationshipThrows: true });
  const res = await h.svc.applyInbound({ ...CONTACT_UPSERT, lamport: 7, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "apply-incomplete");
  // The relationship was attempted (and failed); the contact gate was NOT opened,
  // and no thread was created — no stranded half-state.
  assert.equal(h.calls.upsertRelationship.length, 1);
  assert.equal(h.calls.ensureActive.length, 0, "contact NOT activated when the relationship write failed");
  assert.equal(h.calls.ensureThread.length, 0);

  // seen was NOT advanced → a later (healthy) re-delivery of the SAME event re-applies.
  const h2 = makeHarness({ kv, relationshipThrows: false });
  const res2 = await h2.svc.applyInbound({ ...CONTACT_UPSERT, lamport: 7, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.equal(res2.applied, true, "the same event re-applies once the fault clears (seen was not poisoned)");
  assert.equal(h2.calls.ensureActive.length, 1);
});

test("applyInbound is idempotent: replays and older lamports for the same origin are ignored", async () => {
  const { svc, calls } = makeHarness();
  await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 5, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  const replay = await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 5, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, "stale");
  const older = await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 4, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.equal(older.applied, false);
  assert.equal(calls.ensureActive.length, 1, "applied exactly once");
  // A HIGHER lamport from the same origin applies.
  const newer = await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 6, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.equal(newer.applied, true);
});

test("AF5/F2: applyInbound drops an event whose origin-device signature fails (no forged origin)", async () => {
  const { svc, calls } = makeHarness({ sigValid: false });
  const res = await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 5, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "forgedPub", sig: "forged" });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "bad-signature");
  assert.equal(calls.ensureActive.length, 0, "nothing applied for an unverified event");
  assert.equal(calls.upsertRelationship.length, 0);
});

test("AF5: applyInbound drops an event when no verifier is available (fail-closed)", async () => {
  const { svc } = makeHarness();
  // Strip the verifier from the runtime peer-links to simulate a misconfig.
  svc.bus.runtime.peerLinks.verifyAccountStateEventSig = undefined;
  const res = await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 5, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "p", sig: "s" });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "unverifiable");
});

test("replicate signs the fanned event with this device's key", async () => {
  const { svc, calls } = makeHarness();
  await svc.replicate(CONTACT_UPSERT);
  assert.equal(calls.deposits[0].event.originDevicePublicKeyB64, "selfPubB64", "carries the origin device pubkey");
  assert.equal(calls.deposits[0].event.sig, "sig-rez:dev:self", "carries the origin-device signature");
});

test("applyInbound never applies our OWN emit (loop guard)", async () => {
  const { svc, calls } = makeHarness();
  const res = await svc.applyInbound({ ...CONTACT_UPSERT, lamport: 9, originDeviceId: "rez:dev:self", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.deepEqual(res, { applied: false, reason: "self-origin" });
  assert.equal(calls.ensureActive.length, 0);
});

test("applyInbound contact.remove deletes the contact", async () => {
  const { svc, calls } = makeHarness();
  const res = await svc.applyInbound({ op: "contact.remove", payload: { accountId: "rez:acct:carol" }, lamport: 3, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.deepEqual(res, { applied: true });
  assert.equal(calls.deleteContact.length, 1);
  assert.equal(calls.deleteContact[0].accountId, "rez:acct:carol");
});

test("applyInbound rejects a malformed event", async () => {
  const { svc } = makeHarness();
  const res = await svc.applyInbound({ op: "bogus", payload: {}, lamport: 1, originDeviceId: "rez:dev:sib", issuedAtMs: 1000, originDevicePublicKeyB64: "sibPubB64", sig: "s" });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "invalid");
});
