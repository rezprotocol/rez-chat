import test from "node:test";
import assert from "node:assert/strict";

import { ContactStore } from "../src/server/storage/ChatContactStore.js";
import { ConnectRequestStore } from "../src/server/storage/ConnectRequestStore.js";
import { ServerContactsService } from "../src/server/services/ServerContactsService.js";
import { ConnectRequestPayloadV1 } from "../src/records/payloads/ConnectRequestPayloadV1.js";

/**
 * Connect-request (group co-member → DM, approve/deny gate) server coverage.
 * Drives ServerContactsService directly with a fake bus: real Contact +
 * ConnectRequest stores, faked invites service and sdk seal/dispatch — so the
 * test isolates the request/approve/deny logic from the X3DH peer-link stack.
 */

class TestKVStore {
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

class TestStorageProvider {
  constructor() { this._stores = new Map(); }
  getKeyValueStore(name) {
    if (!this._stores.has(name)) this._stores.set(name, new TestKVStore());
    return this._stores.get(name);
  }
}

const OWNER = "rez:acct:owner";
const PEER = "rez:acct:peer";

function makeHarness({ createInvite, acceptInvite, coMembers = [], peerLinks = [], storedDirectThreads = {} } = {}) {
  const storage = new TestStorageProvider();
  const clock = () => 5000;
  const contactStore = new ContactStore({ storageProvider: storage, clock });
  const connectRequestStore = new ConnectRequestStore({ storageProvider: storage, clock });
  const emitted = [];
  const sealCalls = [];
  const dispatchCalls = [];
  const deletedThreadIds = [];
  const systemMessages = [];
  const coMemberSet = new Set(coMembers);
  const bus = {
    services: {},
    stores: {
      groupStore: {
        async isCoMember({ accountId } = {}) { return coMemberSet.has(accountId); },
      },
    },
    runtime: {
      sdk: {
        async sealForPeer({ peerAccountId, plaintextBodyBytes }) {
          sealCalls.push({ peerAccountId, body: JSON.parse(new TextDecoder().decode(plaintextBodyBytes)) });
          return { object: { id: "obj" }, address: { inboxId: "peer-inbox" } };
        },
        mesh: {
          async dispatch(object, address) { dispatchCalls.push({ object, address }); },
        },
      },
    },
    on() { return () => {}; },
    emit(name, payload) { emitted.push({ name, payload }); },
    registerFunction() {},
    async call(namespace, name) {
      if (namespace === "peer-links" && name === "list") return { items: peerLinks };
      throw new Error("unexpected bus.call " + namespace + "." + name);
    },
  };
  // Fake threads service mirroring the real derive + deleteThread surface the
  // contact-delete cascade relies on. directThreadIdForPeerLink is deterministic
  // (peerLinkId-keyed), so the cascade resolves the same id the materialize path
  // would have created.
  bus.services.threads = {
    directThreadIdForPeerLink(peerLinkId) {
      const id = String(peerLinkId || "").trim();
      return id ? "th_" + id : "";
    },
    // Drift-proof stored-record scan: returns threadIds whose STORED record
    // names this peer, independent of the current peer-links list. Mirrors the
    // real ServerThreadsService.listDirectThreadIdsForPeer.
    async listDirectThreadIdsForPeer(peerAccountId) {
      const id = typeof peerAccountId === "string" ? peerAccountId.trim() : "";
      const ids = storedDirectThreads && Array.isArray(storedDirectThreads[id]) ? storedDirectThreads[id] : [];
      return ids.slice();
    },
    async deleteThread({ threadId } = {}) {
      deletedThreadIds.push(threadId);
      return true;
    },
    async persistConnectAcceptedSystemMessage(args) {
      systemMessages.push(args);
    },
  };
  const acceptCalls = [];
  bus.services.invites = {
    async createInvite(params) {
      if (createInvite) return createInvite(params);
      return { inviteCode: "INV-default", inviteId: "iv1", state: "pending" };
    },
    async acceptInvite(params) {
      acceptCalls.push(params);
      if (acceptInvite) return acceptInvite(params);
      // Simulate the real acceptInvite contact-ensure side effect.
      await contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });
      return { peerAccountId: PEER, state: "established" };
    },
  };
  const service = new ServerContactsService({ bus, contactStore, connectRequestStore, ownerAccountId: OWNER, clock });
  bus.services.contacts = service;
  return { service, contactStore, connectRequestStore, emitted, sealCalls, dispatchCalls, acceptCalls, deletedThreadIds, systemMessages };
}

test("requestConnect mints an invite, ships it sealed, and records outgoing pending state", async () => {
  const h = makeHarness({ createInvite: () => ({ inviteCode: "INV-abc", inviteId: "iv1", state: "pending" }) });
  const res = await h.service.requestConnect({ peerAccountId: PEER, displayName: "Owner", groupId: "g1" });
  assert.equal(res.status, "sent");

  // Sealed payload carries the connect-request kind + our invite code.
  assert.equal(h.sealCalls.length, 1);
  assert.equal(h.dispatchCalls.length, 1);
  assert.equal(h.sealCalls[0].peerAccountId, PEER);
  assert.equal(h.sealCalls[0].body.kind, "rez.connect-request.v1");
  assert.equal(h.sealCalls[0].body.requesterAccountId, OWNER);
  assert.equal(h.sealCalls[0].body.inviteCode, "INV-abc");
  // Our own label rides the sealed payload so the recipient's prompt reads
  // "Owner wants to connect".
  assert.equal(h.sealCalls[0].body.displayName, "Owner");

  // Outgoing request + invited contact persisted.
  const req = await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER });
  assert.equal(req.direction, "outgoing");
  assert.equal(req.state, "pending");
  assert.equal(req.inviteCode, "INV-abc");
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.relationshipState, "invited");
  // The requester-side placeholder must NOT be named with the requester's own
  // label — that label is OURS, shipped to the peer, not the peer's name. The
  // peer's name arrives later via profile exchange / acceptInvite. (Regression:
  // self-naming made the requester's pending thread title show their own name.)
  assert.notEqual(contact.displayName, "Owner");
});

test("requestConnect is a no-op when already an active contact", async () => {
  const h = makeHarness();
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });
  const res = await h.service.requestConnect({ peerAccountId: PEER });
  assert.equal(res.status, "already-connected");
  assert.equal(h.sealCalls.length, 0);
});

test("handleIncomingConnectRequest stores an incoming request + invited contact", async () => {
  // A connect request legitimately comes from a co-member (REZ-8 gate).
  const h = makeHarness({ coMembers: [PEER] });
  const payload = new ConnectRequestPayloadV1({
    requestId: "cr1",
    requesterAccountId: PEER,
    inviteCode: "INV-peer",
    groupId: "g1",
    displayName: "Peer",
    createdAtMs: 1000,
  });
  const consumed = await h.service.handleIncomingConnectRequest(payload, { senderAccountId: PEER, groupId: "g1" });
  assert.equal(consumed, true);
  const req = await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER });
  assert.equal(req.direction, "incoming");
  assert.equal(req.inviteCode, "INV-peer");
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.relationshipState, "invited");
});

test("handleIncomingConnectRequest drops a request with no authenticated sender", async () => {
  const h = makeHarness();
  const payload = new ConnectRequestPayloadV1({
    requestId: "cr1", requesterAccountId: PEER, inviteCode: "INV-peer", createdAtMs: 1000,
  });
  const consumed = await h.service.handleIncomingConnectRequest(payload, { senderAccountId: "" });
  assert.equal(consumed, false);
  const req = await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER });
  assert.equal(req, null);
});

test("handleIncomingConnectRequest drops a request from a non-co-member (REZ-8)", async () => {
  // No co-membership and no prior contact: a deleted-but-still-linked peer must
  // not be able to spam approve/deny prompts.
  const h = makeHarness();
  const payload = new ConnectRequestPayloadV1({
    requestId: "cr1", requesterAccountId: PEER, inviteCode: "INV-peer", createdAtMs: 1000,
  });
  const consumed = await h.service.handleIncomingConnectRequest(payload, { senderAccountId: PEER });
  assert.equal(consumed, true, "consumed (dropped, not retried)");
  const req = await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER });
  assert.equal(req, null, "no request stored for a non-co-member");
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact, null, "no invited placeholder created for a non-co-member");
});

test("handleIncomingConnectRequest AUTO-RECONNECTS a requester we already hold active", async () => {
  // Asymmetric reconnect (live, 2026-06-12): WE kept them as an active contact,
  // but THEY lost us (deleted us / wiped) and re-invited. Silently consuming the
  // request stranded them in `invited` forever — they never heard back. Now we
  // auto-accept their fresh invite with forceReestablish (re-key our still-healthy
  // link so a handshake actually reaches them) and signal acceptance back. No
  // prompt, no incoming-request bookkeeping — we already consented once.
  const h = makeHarness({ storedDirectThreads: { [PEER]: ["th_peerlink1"] } });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active", displayName: "Peer" } });

  const payload = new ConnectRequestPayloadV1({
    requestId: "cr1", requesterAccountId: PEER, inviteCode: "INV-peer-fresh", createdAtMs: 1000,
  });
  const consumed = await h.service.handleIncomingConnectRequest(payload, { senderAccountId: PEER });
  assert.equal(consumed, true);

  // Auto-accepted their fresh invite, FORCING a re-key of the existing link
  // (a plain accept on a healthy link would be idempotent and send nothing).
  assert.equal(h.acceptCalls.length, 1, "auto-accepted the requester's invite");
  assert.equal(h.acceptCalls[0].inviteCode, "INV-peer-fresh");
  assert.equal(h.acceptCalls[0].forceReestablish, true, "forced re-key so a handshake actually reaches them");

  // Signalled acceptance back so THEIR side activates + re-materializes the thread
  // (the reused-link snapshot can't — stale activeInviteId).
  const signal = h.sealCalls.find((c) => c.body && c.body.kind === "rez.chat.connect-accepted.v1");
  assert.ok(signal, "connect-accepted signal sent back to the requester");
  assert.equal(signal.peerAccountId, PEER);

  // No prompt bookkeeping: no incoming request stored, our own contact untouched.
  assert.equal(await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER }), null,
    "no incoming connect-request stored (we did not prompt)");
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.relationshipState, "active", "our active contact is preserved");
  assert.equal(contact.displayName, "Peer", "their name on our side is preserved");
});

test("approveConnectRequest accepts the peer invite and clears the request", async () => {
  const h = makeHarness({ coMembers: [PEER] });
  const payload = new ConnectRequestPayloadV1({
    requestId: "cr1", requesterAccountId: PEER, inviteCode: "INV-peer", createdAtMs: 1000,
  });
  await h.service.handleIncomingConnectRequest(payload, { senderAccountId: PEER });
  const res = await h.service.approveConnectRequest({ accountId: PEER });
  assert.equal(res.status, "approved");
  assert.equal(h.acceptCalls.length, 1);
  assert.equal(h.acceptCalls[0].inviteCode, "INV-peer");
  // Request consumed; contact flipped to active by the (faked) acceptInvite path.
  const req = await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER });
  assert.equal(req, null);
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.relationshipState, "active");
});

test("approveConnectRequest throws when there is no pending incoming request", async () => {
  const h = makeHarness();
  await assert.rejects(() => h.service.approveConnectRequest({ accountId: PEER }), /NO_PENDING_REQUEST|no pending/);
});

test("denyConnectRequest silently drops the request and the invited placeholder contact", async () => {
  const h = makeHarness({ coMembers: [PEER] });
  const payload = new ConnectRequestPayloadV1({
    requestId: "cr1", requesterAccountId: PEER, inviteCode: "INV-peer", createdAtMs: 1000,
  });
  await h.service.handleIncomingConnectRequest(payload, { senderAccountId: PEER });
  const res = await h.service.denyConnectRequest({ accountId: PEER });
  assert.equal(res.status, "denied");
  assert.equal(res.deleted, true);
  const req = await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER });
  assert.equal(req, null);
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact, null);
  // Authoritative removal event drives the client store — the deny path no
  // longer hand-patches the renderer's contact list.
  assert.ok(
    h.emitted.some((e) => e.name === "contact.removed" && e.payload && e.payload.accountId === PEER),
    "emits contact.removed for the denied placeholder",
  );
});

test("denyConnectRequest never deletes an already-active contact", async () => {
  const h = makeHarness();
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });
  await h.connectRequestStore.upsert({
    ownerAccountId: OWNER, peerAccountId: PEER, direction: "incoming", requestId: "cr1", inviteCode: "INV-peer",
  });
  await h.service.denyConnectRequest({ accountId: PEER });
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.relationshipState, "active");
  assert.ok(
    !h.emitted.some((e) => e.name === "contact.removed"),
    "never emits contact.removed when the contact was active (not the placeholder)",
  );
});

test("deleteContact emits contact.removed so the client store drops it without hand-patching", async () => {
  const h = makeHarness();
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });
  const res = await h.service.deleteContact({ accountId: PEER });
  assert.equal(res.deleted, true);
  assert.ok(
    h.emitted.some((e) => e.name === "contact.removed" && e.payload && e.payload.accountId === PEER),
    "emits contact.removed for the deleted contact",
  );
});

test("deleteContact does not emit contact.removed when there was no contact to delete", async () => {
  const h = makeHarness();
  const res = await h.service.deleteContact({ accountId: PEER });
  assert.equal(res.deleted, false);
  assert.ok(
    !h.emitted.some((e) => e.name === "contact.removed"),
    "no removal event when nothing was deleted",
  );
});

test("deleteContact DEMOTES a shared-group co-member to a name-only `known` row (keeps the name)", async () => {
  // SSOT: the contact row is the SINGLE source of a co-member's display name.
  // Removing the DM must NOT erase the name — the shared group roster resolves
  // it by accountId. So a co-member is demoted to `known`, not hard-deleted;
  // otherwise the member shows as a bare id in the group (live bug, 2026-06-12:
  // "Carol deletes Alice, Alice's name vanishes in the group too").
  const h = makeHarness({ coMembers: [PEER], storedDirectThreads: { [PEER]: ["th_peerlink1"] } });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active", displayName: "Alice" } });

  const res = await h.service.deleteContact({ accountId: PEER });
  assert.equal(res.deleted, true);

  // Row survives as a name-only `known` entry with the name intact.
  const row = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.ok(row, "co-member row is NOT hard-deleted");
  assert.equal(row.relationshipState, "known", "demoted to a name-only known row");
  assert.equal(row.displayName, "Alice", "name retained for the shared group roster");
  assert.equal(await h.service.isActiveContact(PEER), false, "no longer an active contact / DM");

  // The DM thread is still torn down — the 1:1 relationship genuinely ended.
  assert.deepEqual(h.deletedThreadIds, ["th_peerlink1"]);

  // contact.updated (NOT contact.removed): clients keep the name-only row but
  // drop it from the active contact list (activeContacts filters `known`).
  assert.ok(
    h.emitted.some((e) => e.name === "contact.updated" && e.payload && e.payload.contact && e.payload.contact.accountId === PEER),
    "emits contact.updated to refresh the demoted row",
  );
  assert.ok(
    !h.emitted.some((e) => e.name === "contact.removed"),
    "does NOT emit contact.removed for a co-member (the name must survive)",
  );
});

test("deleteContact still HARD-DELETES a contact who shares no group", async () => {
  // No co-membership → nothing else holds the name → fully remove the row, as
  // before. Guards against the demote path leaking stranded `known` rows.
  const h = makeHarness({ coMembers: [], storedDirectThreads: { [PEER]: ["th_peerlink1"] } });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active", displayName: "Alice" } });

  const res = await h.service.deleteContact({ accountId: PEER });
  assert.equal(res.deleted, true);
  assert.equal(await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER }), null, "row physically removed");
  assert.deepEqual(h.deletedThreadIds, ["th_peerlink1"], "DM thread torn down");
  assert.ok(
    h.emitted.some((e) => e.name === "contact.removed" && e.payload && e.payload.accountId === PEER),
    "emits contact.removed (no name source to preserve)",
  );
});

// --- strict materialize predicate: only an ACTIVE contact surfaces a DM ---

test("isActiveContact reflects only the active relationship state", async () => {
  const h = makeHarness();
  assert.equal(await h.service.isActiveContact(PEER), false); // no record
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "invited" } });
  assert.equal(await h.service.isActiveContact(PEER), false); // pending
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });
  assert.equal(await h.service.isActiveContact(PEER), true);
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "blocked" } });
  assert.equal(await h.service.isActiveContact(PEER), false); // blocked
});

// --- requester-side acceptance: peer's first DM resolves our outgoing request ---

test("acceptOutgoingConnectRequest activates the contact and clears a pending outgoing request", async () => {
  // The live bug: Alice connect-requests Bob (already co-members). Bob approves,
  // but accepting reuses the existing co-member peer-link, so Alice's snapshot
  // gate never flips the contact and Bob's DMs were dropped as "non-contact".
  // The delivery gate calls this when Bob's first authenticated DM arrives.
  const h = makeHarness();
  await h.connectRequestStore.upsert({
    ownerAccountId: OWNER, peerAccountId: PEER, direction: "outgoing", requestId: "cr1", inviteCode: "INV-abc",
  });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "invited" } });

  const resolved = await h.service.acceptOutgoingConnectRequest(PEER);
  assert.equal(resolved, true);
  // Contact flipped invited -> active, and the request row consumed.
  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.relationshipState, "active");
  assert.equal(await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER }), null);
});

test("acceptOutgoingConnectRequest is a no-op without a pending OUTGOING request", async () => {
  const h = makeHarness();
  // No request at all.
  assert.equal(await h.service.acceptOutgoingConnectRequest(PEER), false);
  // An INCOMING request must not be resolved by this requester-side path.
  await h.connectRequestStore.upsert({
    ownerAccountId: OWNER, peerAccountId: PEER, direction: "incoming", requestId: "cr1", inviteCode: "INV-peer",
  });
  assert.equal(await h.service.acceptOutgoingConnectRequest(PEER), false);
  // The incoming request is left intact.
  const req = await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER });
  assert.equal(req.direction, "incoming");
  // Empty id is rejected.
  assert.equal(await h.service.acceptOutgoingConnectRequest(""), false);
});

// --- connect-accepted starter: approval posts a system row + signals requester ---

test("approveConnectRequest posts the approver's system row and signals the requester", async () => {
  // PEER asked us to connect; we approve. acceptInvite materializes our direct
  // thread; we then post our own "connect.accepted" system row into it and ship
  // the one-shot trigger so the requester gets the same starter + a thread.
  const h = makeHarness({ storedDirectThreads: { [PEER]: ["th_peerlink1"] } });
  await h.connectRequestStore.upsert({
    ownerAccountId: OWNER, peerAccountId: PEER, direction: "incoming", requestId: "cr1", inviteCode: "INV-peer",
  });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "invited" } });

  const res = await h.service.approveConnectRequest({ accountId: PEER, acceptorDisplayName: "Owner" });
  assert.equal(res.status, "approved");

  // Our own system row went into our direct thread, actored by us (the acceptor).
  assert.equal(h.systemMessages.length, 1);
  assert.equal(h.systemMessages[0].threadId, "th_peerlink1");
  assert.equal(h.systemMessages[0].acceptorAccountId, OWNER);
  assert.equal(h.systemMessages[0].acceptorDisplayName, "Owner");

  // The trigger was sealed to the requester with the connect-accepted kind.
  const signal = h.sealCalls.find((c) => c.body && c.body.kind === "rez.chat.connect-accepted.v1");
  assert.ok(signal, "expected a sealed connect-accepted signal");
  assert.equal(signal.peerAccountId, PEER);
  assert.equal(signal.body.senderAccountId, OWNER);
  assert.equal(signal.body.acceptorDisplayName, "Owner");
});

test("handleIncomingConnectAccepted persists the requester-side system row", async () => {
  // Requester side: the gate already activated the contact + resolved our thread
  // (ctx.threadId). The dispatch handler drops the matching starter row, actored
  // by the ACCEPTOR (the authenticated sender), and consumes the trigger.
  const h = makeHarness();
  const consumed = await h.service.handleIncomingConnectAccepted(
    { acceptorDisplayName: "Peer", actedAtMs: 7000 },
    { senderAccountId: PEER, threadId: "th_mine" },
  );
  assert.equal(consumed, true);
  assert.equal(h.systemMessages.length, 1);
  assert.equal(h.systemMessages[0].threadId, "th_mine");
  assert.equal(h.systemMessages[0].acceptorAccountId, PEER);
  assert.equal(h.systemMessages[0].acceptorDisplayName, "Peer");
  assert.equal(h.systemMessages[0].actedAtMs, 7000);
});

test("handleIncomingConnectAccepted NAMES + activates the requester's contact from a pending outgoing request", async () => {
  // Regression (live dev:three, 2026-06-10): when both sides were already group
  // co-members, accepting our direct invite reuses the co-member peer-link, so NO
  // peer-link "established" snapshot fires on our side — the path that normally
  // carries remoteDisplayName is skipped and the contact would activate nameless.
  // The authenticated connect-accepted signal carries the approver's name; apply it.
  const h = makeHarness();
  await h.connectRequestStore.upsert({
    ownerAccountId: OWNER, peerAccountId: PEER, direction: "outgoing", requestId: "cr1", inviteCode: "INV-abc",
  });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "invited" } });

  await h.service.handleIncomingConnectAccepted(
    { acceptorDisplayName: "Bob", actedAtMs: 7000 },
    { senderAccountId: PEER, threadId: "th_mine" },
  );

  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.relationshipState, "active", "contact activated by the accepted signal");
  assert.equal(contact.displayName, "Bob", "approver's display name applied (was nameless before)");
  // Pending outgoing request consumed.
  assert.equal(await h.connectRequestStore.get({ ownerAccountId: OWNER, peerAccountId: PEER }), null);
});

test("handleIncomingConnectAccepted names an ALREADY-active contact (direct content won the race)", async () => {
  // The first authenticated DM may activate the contact (nameless) before the
  // connect-accepted signal lands; the signal must still backfill the name.
  const h = makeHarness();
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });

  await h.service.handleIncomingConnectAccepted(
    { acceptorDisplayName: "Bob", actedAtMs: 7000 },
    { senderAccountId: PEER, threadId: "th_mine" },
  );

  const contact = await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER });
  assert.equal(contact.displayName, "Bob", "name backfilled onto the already-active contact");
});

test("handleIncomingConnectAccepted does NOT mint a contact for an unsolicited signal", async () => {
  // Security: a co-member could craft a connect-accepted we never requested. With
  // no pending outgoing request and no existing contact, naming must NOT create one.
  const h = makeHarness();
  await h.service.handleIncomingConnectAccepted(
    { acceptorDisplayName: "Mallory", actedAtMs: 7000 },
    { senderAccountId: PEER, threadId: "th_mine" },
  );
  assert.equal(await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER }), null,
    "no contact minted from an unsolicited connect-accepted");
});

test("handleIncomingConnectAccepted falls back to a stored thread when ctx has none", async () => {
  const h = makeHarness({ storedDirectThreads: { [PEER]: ["th_fallback"] } });
  const consumed = await h.service.handleIncomingConnectAccepted(
    { actedAtMs: 7000 },
    { senderAccountId: PEER, threadId: "" },
  );
  assert.equal(consumed, true);
  assert.equal(h.systemMessages.length, 1);
  assert.equal(h.systemMessages[0].threadId, "th_fallback");
});

test("handleIncomingConnectAccepted consumes (no row) when no thread can be resolved", async () => {
  const h = makeHarness();
  const consumed = await h.service.handleIncomingConnectAccepted(
    { actedAtMs: 7000 },
    { senderAccountId: PEER, threadId: "" },
  );
  // Consumed so the trigger never renders as a bubble, but nothing persisted.
  assert.equal(consumed, true);
  assert.equal(h.systemMessages.length, 0);
});

// --- delete cascade: deleting a contact hard-deletes its DM thread(s) ---

test("deleteContact tears down every direct thread bound to the peer's link(s)", async () => {
  // Two peer-links for the same peer (e.g. after a recovery-via-reinvite
  // re-establishment) plus an unrelated link that must be left alone.
  const h = makeHarness({
    peerLinks: [
      { peerLinkId: "pl-a", peerAccountId: PEER },
      { peerLinkId: "pl-b", peerAccountId: PEER },
      { peerLinkId: "pl-other", peerAccountId: "rez:acct:other" },
    ],
  });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });

  const res = await h.service.deleteContact({ accountId: PEER });
  assert.equal(res.deleted, true);
  // Contact row gone.
  assert.equal(await h.contactStore.get({ ownerAccountId: OWNER, accountId: PEER }), null);
  // Both of the peer's threads torn down (deleteThread drops messages + index
  // row); the unrelated peer's thread untouched.
  assert.deepEqual(h.deletedThreadIds.sort(), ["th_pl-a", "th_pl-b"]);
});

test("deleteContact still succeeds when the peer has no direct thread", async () => {
  const h = makeHarness({ peerLinks: [] });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });
  const res = await h.service.deleteContact({ accountId: PEER });
  assert.equal(res.deleted, true);
  assert.equal(h.deletedThreadIds.length, 0);
});

test("deleteContact tears down a thread whose peer-link drifted away (recovery-via-reinvite)", async () => {
  // The live bug: Alice had Bob with message history; after a recovery-via-
  // reinvite Bob's thread is keyed to an OLD peerLinkId ("th_pl-stale") that no
  // longer appears in the live peer-links list. Deriving the threadId from the
  // CURRENT links alone misses it, stranding a bare-id orphan. The stored-record
  // scan (listDirectThreadIdsForPeer) finds it by its stored peerAccountId.
  const h = makeHarness({
    peerLinks: [
      // Current link present, but its derived thread record was never written
      // (e.g. no messages yet) — covered by the belt-and-suspenders derivation.
      { peerLinkId: "pl-current", peerAccountId: PEER },
    ],
    storedDirectThreads: {
      [PEER]: ["th_pl-stale"],
    },
  });
  await h.contactStore.upsert({ ownerAccountId: OWNER, accountId: PEER, patch: { relationshipState: "active" } });

  const res = await h.service.deleteContact({ accountId: PEER });
  assert.equal(res.deleted, true);
  // Both the drifted (stored-record) thread AND the current-link derivation are
  // torn down; nothing stranded.
  assert.deepEqual(h.deletedThreadIds.sort(), ["th_pl-current", "th_pl-stale"]);
});
