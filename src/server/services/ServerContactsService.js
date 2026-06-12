import {
  ContactsBlockParams,
  ContactsBlockResult,
  ContactsDeleteParams,
  ContactsDeleteResult,
  ContactsListParams,
  ContactsListResult,
  ContactsRenameParams,
  ContactsRenameResult,
  ContactsUnblockParams,
  ContactsUnblockResult,
  ContactUpdatedEvent,
  ContactRemovedEvent,
  ConnectRequestUpdatedEvent,
} from "../../records/index.js";
import { ConnectRequestPayloadV1, ChatConnectAcceptedPayloadV1 } from "../../records/payloads/index.js";
import { BaseServerService } from "../base/BaseServerService.js";

export class ServerContactsService extends BaseServerService {
  #contactStore;
  #connectRequestStore;
  #clock;

  constructor({ bus, contactStore, connectRequestStore = null, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!contactStore) {
      throw new Error("ServerContactsService requires contactStore");
    }
    this.#contactStore = contactStore;
    this.#connectRequestStore = connectRequestStore;
    this.#clock = clock;
    this._register("contacts", "list", (payload) => this.listContacts(payload));
    this._register("contacts", "rename", (payload) => this.renameContact(payload));
    this._register("contacts", "block", (payload) => this.blockContact(payload));
    this._register("contacts", "unblock", (payload) => this.unblockContact(payload));
    this._register("contacts", "delete", (payload) => this.deleteContact(payload));
    this._register("contacts", "requestConnect", (payload) => this.requestConnect(payload));
    this._register("contacts", "approveConnectRequest", (payload) => this.approveConnectRequest(payload));
    this._register("contacts", "denyConnectRequest", (payload) => this.denyConnectRequest(payload));
    this._register("contacts", "listConnectRequests", () => this.listConnectRequests());
  }

  async ensureActiveContact({ accountId, displayName = "", lastSeenAtMs = null } = {}) {
    if (typeof accountId !== "string" || accountId.trim().length === 0) return null;
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId,
      patch: {
        relationshipState: "active",
        displayName: displayName || undefined,
        lastSeenAtMs: lastSeenAtMs == null ? this.#clock() : lastSeenAtMs,
      },
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return contact;
  }

  /**
   * Record a co-member's VERIFIED display name in the one account table as a
   * `known` row — the single source of truth for "what is account X called".
   *
   * A `known` row carries a name but is NOT a relationship: it is excluded from
   * the active contact list (ContactQueries.activeContacts) and never gets a DM
   * thread (isActiveContact gates on "active"). This is how a group roster
   * resolves a member's name by accountId without duplicating the name onto the
   * membership row AND without violating strict contacts/groups separation.
   *
   * Fail-closed for relationship integrity: writes only when there is NO row, or
   * the existing row is already `known` (refresh the name). NEVER downgrades an
   * invited/active/blocked relationship, and never creates a thread. Caller MUST
   * pass a cryptographically-verified name (member.join / member.contact consent
   * proof) — we are about to display it as that account's name.
   */
  async ensureKnownAccount({ accountId, displayName } = {}) {
    const id = typeof accountId === "string" ? accountId.trim() : "";
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!id || id === this.ownerAccountId || !name) return null;
    const existing = await this.#contactStore.get({
      ownerAccountId: this.ownerAccountId, accountId: id,
    }).catch(() => null);
    if (existing) {
      const state = String(existing.relationshipState || "").toLowerCase();
      // An invited/active/blocked relationship already owns this account row —
      // its name is maintained by that relationship's own flow. Don't downgrade.
      if (state !== "known") return existing;
      // Already a known row with this exact name — nothing to write/emit.
      if (existing.displayName === name) return existing;
    }
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId: id,
      patch: { relationshipState: "known", displayName: name },
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return contact;
  }

  /**
   * True when we hold an `active` (approved) contact for this account. The
   * peer-link-established path (inviter/requester side) uses this to decide
   * whether to materialize a DM thread + conversation-list row: only an already-
   * accepted relationship surfaces. A bare `invited` placeholder (an unaccepted
   * outgoing connect-request), a co-member transport link, and a group-invite
   * membership all read false, so none prematurely show a conversation.
   */
  async isActiveContact(accountId) {
    const id = typeof accountId === "string" ? accountId.trim() : "";
    if (!id) return false;
    const existing = await this.#contactStore.get({ ownerAccountId: this.ownerAccountId, accountId: id });
    return Boolean(existing && String(existing.relationshipState || "").toLowerCase() === "active");
  }

  async listContacts(payload = {}) {
    this._coerceParams(payload, ContactsListParams);
    const items = await this.#contactStore.listAll({ ownerAccountId: this.ownerAccountId });
    return new ContactsListResult({ items });
  }

  async renameContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsRenameParams);
    const result = await this.#contactStore.rename({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
      displayName: params.displayName,
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return new ContactsRenameResult({ contact });
  }

  async blockContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsBlockParams);
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
      patch: { relationshipState: "blocked" },
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return new ContactsBlockResult({ contact });
  }

  async unblockContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsUnblockParams);
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
      patch: { relationshipState: "active" },
    });
    const contact = result && result.contact ? result.contact : null;
    this.#emitContactUpdated(contact);
    return new ContactsUnblockResult({ contact });
  }

  async deleteContact(payload = {}) {
    const params = this._coerceParams(payload, ContactsDeleteParams);

    // Tear down the 1:1 DM regardless of how we dispose of the contact row
    // below: a contact and its DM thread are one relationship, and removing the
    // contact ends the conversation. Leaving only the contact row strands the
    // conversation — the threadIndex row and stored messages live on, the
    // orphaned thread shows in the list, and a later re-invite collides with it
    // (the "busted thread on re-invite" live-test bug). This one call drops the
    // thread's messages + conversation-list row and notifies the UI.
    //
    // We deliberately do NOT tear down the peer-link transport itself: under
    // strict contacts/groups separation a link with no contact and no thread is
    // invisible (both materialize gates require isActiveContact ||
    // isDirectContactInvite), and recovery-via-reinvite reuses that existing
    // link to re-establish on a later re-invite. Removing it would break the
    // very re-invite this cleanup exists to unblock.
    await this.#deleteDirectThreadsForPeer(params.accountId);

    // A contact who is ALSO a verified group co-member is the SINGLE source of
    // that account's display name (the one account table, keyed by accountId).
    // Hard-deleting the row would erase the name from every shared group roster
    // too. So when the peer is still an active member of a group we share,
    // DEMOTE the row to a name-only `known` state instead of deleting it: the
    // 1:1 contact and its DM thread are gone (above), but the name survives for
    // the group. The upsert keeps the existing displayName. A peer in no shared
    // group is deleted outright, as before.
    const existing = await this.#contactStore.get({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
    }).catch(() => null);
    if (existing && await this.#isCoMember(params.accountId)) {
      const demoted = await this.#contactStore.upsert({
        ownerAccountId: this.ownerAccountId,
        accountId: params.accountId,
        patch: { relationshipState: "known" },
      });
      // contact.updated (NOT contact.removed): the row survives as a name-only
      // `known` entry. Clients drop it from the active contact list
      // (activeContacts filters `known`) yet keep resolving the name by id for
      // the shared group roster — one source of truth, preserved.
      const contact = demoted && demoted.contact ? demoted.contact : null;
      this.#emitContactUpdated(contact);
      return new ContactsDeleteResult({ deleted: true });
    }

    const result = await this.#contactStore.delete({
      ownerAccountId: this.ownerAccountId,
      accountId: params.accountId,
    });
    // Authoritative removal event so every client store/view drops the contact
    // (and its no-longer-resolvable name) without the call site hand-patching
    // its local store. The thread teardown above fires its own thread.removed.
    if (result && result.deleted === true) {
      this.#emitContactRemoved(params.accountId);
    }
    return new ContactsDeleteResult({ deleted: result && result.deleted === true });
  }

  /**
   * True when this peer is an active member of a group we are also in. A
   * co-member is the single source of that account's display name for the
   * shared roster, so deleting the contact must preserve the name (demote to
   * `known`) rather than erase it. Fail-closed to "not a co-member" when the
   * group store is unavailable or the check errors — that keeps the prior
   * hard-delete behavior and the failure is logged, not silently swallowed.
   */
  async #isCoMember(accountId) {
    const groupStore = this.bus && this.bus.stores ? this.bus.stores.groupStore : null;
    if (!groupStore || typeof groupStore.isCoMember !== "function") return false;
    return groupStore.isCoMember({ ownerAccountId: this.ownerAccountId, accountId })
      .catch((err) => {
        this.logger.warn(
          "[ServerContactsService] co-member check failed during deleteContact",
          err && err.message ? err.message : err,
        );
        return false;
      });
  }

  /**
   * Delete every direct DM thread bound to a peer account (its messages and
   * conversation-list row go with it). The direct threadId is derived from the
   * peer-link id, and a peer may hold more than one link (e.g. after a
   * recovery-via-reinvite re-establishment), so we sweep all matching links.
   * Best-effort: the contact is already gone, so a thread-teardown failure is
   * logged but does not fail the delete (the alternative leaves a stranded
   * contact and a thread both).
   */
  async #deleteDirectThreadsForPeer(accountId) {
    const id = typeof accountId === "string" ? accountId.trim() : "";
    if (!id) return;
    const threads = this.bus.services && this.bus.services.threads ? this.bus.services.threads : null;
    if (!threads || typeof threads.directThreadIdForPeerLink !== "function"
        || typeof threads.deleteThread !== "function") {
      return;
    }
    const threadIds = new Set();
    // Primary: find this peer's direct threads by their STORED peerAccountId.
    // Recovery-via-reinvite replaces the peerLinkId and the old link drops out
    // of the live peer-links list, so deriving the threadId from the current
    // links alone (below) misses any thread keyed to a since-replaced link —
    // exactly the stranded-orphan the delete cascade exists to prevent. The
    // stored record always carries peerAccountId, so this catches them all.
    if (typeof threads.listDirectThreadIdsForPeer === "function") {
      const stored = await threads.listDirectThreadIdsForPeer(id).catch(() => []);
      for (const threadId of Array.isArray(stored) ? stored : []) {
        if (threadId) threadIds.add(threadId);
      }
    }
    // Belt-and-suspenders: also derive from currently-linked peer-links, in
    // case a link exists whose thread record was never written.
    const peerLinksResult = await this._call("peer-links", "list", {});
    const items = peerLinksResult && Array.isArray(peerLinksResult.items) ? peerLinksResult.items : [];
    for (const pl of items) {
      const remoteId = pl && typeof pl.peerAccountId === "string" ? pl.peerAccountId.trim() : "";
      if (remoteId !== id) continue;
      const threadId = threads.directThreadIdForPeerLink(pl.peerLinkId, id);
      if (threadId) threadIds.add(threadId);
    }
    for (const threadId of threadIds) {
      await threads.deleteThread({ threadId }).catch((err) => {
        this.logger.error(
          "[ServerContactsService] direct thread teardown on contact delete failed",
          err && err.message ? err.message : err,
        );
      });
    }
  }

  // --- Connect requests (group co-member → DM, with approve/deny gate) ---

  /**
   * requestConnect: WE ask a group co-member to become a direct contact.
   * Mints a normal direct invite, ships its code to the peer as a sealed
   * ConnectRequestPayloadV1 over our existing co-member peer-link, and records
   * the outgoing request + an `invited` contact for pending display. Resolution
   * is automatic: when the peer approves (acceptInvite), their X3DH handshake
   * establishes our peer-link and the existing peer-link-established path flips
   * the contact to `active`.
   */
  async requestConnect(payload = {}) {
    const peerAccountId = typeof payload.peerAccountId === "string" ? payload.peerAccountId.trim() : "";
    if (!peerAccountId) {
      throw new Error("requestConnect: peerAccountId required");
    }
    if (peerAccountId === this.ownerAccountId) {
      throw new Error("requestConnect: cannot connect to self");
    }
    this.#requireConnectRequestStore();
    const displayName = typeof payload.displayName === "string" ? payload.displayName.trim() : "";
    const groupId = typeof payload.groupId === "string" ? payload.groupId.trim() : "";

    const existingContact = await this.#contactStore.get({ ownerAccountId: this.ownerAccountId, accountId: peerAccountId });
    if (existingContact && existingContact.relationshipState === "active") {
      return { status: "already-connected", peerAccountId };
    }

    const invitesService = this.bus.services && this.bus.services.invites;
    if (!invitesService || typeof invitesService.createInvite !== "function") {
      throw new Error("requestConnect: invites service unavailable");
    }
    const invite = await invitesService.createInvite({ kind: "direct", creatorDisplayName: displayName });
    const inviteCode = invite && typeof invite.inviteCode === "string" ? invite.inviteCode : "";
    if (!inviteCode) {
      throw new Error("requestConnect: createInvite did not yield an inviteCode");
    }

    const now = this.#clock();
    const requestId = "cr_" + now + "_" + Math.random().toString(36).slice(2, 10);
    const requestPayload = new ConnectRequestPayloadV1({
      requestId,
      requesterAccountId: this.ownerAccountId,
      inviteCode,
      groupId: groupId || undefined,
      displayName: displayName || undefined,
      createdAtMs: now,
    });
    await this.#sendSealed(peerAccountId, requestPayload);

    await this.#connectRequestStore.upsert({
      ownerAccountId: this.ownerAccountId,
      peerAccountId,
      direction: "outgoing",
      requestId,
      inviteCode,
      displayName: displayName || null,
      groupId: groupId || null,
      state: "pending",
    });
    // `displayName` here is OUR OWN label (shipped to the peer so their prompt
    // reads "<us> wants to connect"); it is NOT the peer's name. We do not yet
    // know the peer's display name at request time — leave the placeholder
    // unnamed and let profile exchange / acceptInvite's remoteDisplayName fill
    // it in once the link establishes. Stamping our own name here is what made
    // the requester's pending thread title show their own name.
    await this.#upsertInvitedContact(peerAccountId, "");
    this.#emitConnectRequestUpdated(peerAccountId);
    return { status: "sent", peerAccountId, requestId };
  }

  /**
   * handleIncomingConnectRequest: a co-member asked US to connect. Persist the
   * incoming request (carrying THEIR invite code, needed to accept) and surface
   * it as an `invited` contact + a bus event for the approve/deny prompt. The
   * authoritative requester identity is the sealed link sender, never the
   * self-declared `requesterAccountId` field.
   */
  async handleIncomingConnectRequest(record, { senderAccountId, groupId = "" } = {}) {
    const requester = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
    if (!requester) {
      this.logger.warn("[ServerContactsService] connect request without authenticated sender; dropping");
      return false;
    }
    if (!this.#connectRequestStore) {
      this.logger.warn("[ServerContactsService] connect request received but no connectRequestStore; dropping");
      return false;
    }
    const inviteCode = record && typeof record.inviteCode === "string" ? record.inviteCode.trim() : "";
    if (!inviteCode) {
      this.logger.warn("[ServerContactsService] connect request missing inviteCode; dropping");
      return false;
    }
    const existingContact = await this.#contactStore.get({ ownerAccountId: this.ownerAccountId, accountId: requester });
    if (existingContact && existingContact.relationshipState === "active") {
      // We still hold an ACTIVE contact for the requester, but THEY re-invited us
      // — so their side lost the relationship (they deleted us, or recovered from
      // a wipe) while ours survived. Silently consuming here used to strand them
      // in `invited` forever (they never hear back). We already consented to this
      // contact once, so DON'T prompt: auto-reconnect. Re-accept their fresh
      // invite to recover the link, then signal acceptance back so their side
      // activates the contact and re-materializes the thread.
      await this.#autoReconnectActiveRequester(requester, inviteCode);
      return true;
    }
    if (existingContact && existingContact.relationshipState === "blocked") {
      // We BLOCKED this peer. A blocked contact who still shares a group with us
      // would otherwise satisfy the co-member gate below and re-surface
      // approve/deny prompts on demand — blocking would not actually stop them.
      // Consume (don't retry) without storing the request or emitting an event.
      this.logger.warn("[ServerContactsService] connect request from blocked contact " + requester + "; dropping");
      return true;
    }
    // REZ-8: a connect request legitimately comes from a CO-MEMBER (see docstring).
    // deleteContact intentionally keeps the underlying peer-link alive, so without
    // this gate any peer we ONCE linked (e.g. a since-deleted contact) could spam
    // approve/deny prompts on demand. Require current co-membership or an existing
    // (invited/active) contact relationship; otherwise drop (consume — don't retry).
    let requesterAllowed = Boolean(existingContact && existingContact.relationshipState === "invited");
    if (!requesterAllowed) {
      const groupStore = this.bus && this.bus.stores ? this.bus.stores.groupStore : null;
      if (groupStore && typeof groupStore.isCoMember === "function") {
        requesterAllowed = await groupStore.isCoMember({
          ownerAccountId: this.ownerAccountId,
          accountId: requester,
        }).catch(() => false);
      }
    }
    if (!requesterAllowed) {
      this.logger.warn("[ServerContactsService] connect request from non-co-member " + requester + "; dropping");
      return true;
    }
    const displayName = record && typeof record.displayName === "string" ? record.displayName.trim() : "";
    const requestId = record && typeof record.requestId === "string" ? record.requestId.trim() : "";
    const originGroupId = (record && typeof record.groupId === "string" && record.groupId.trim())
      ? record.groupId.trim()
      : (typeof groupId === "string" ? groupId.trim() : "");

    await this.#connectRequestStore.upsert({
      ownerAccountId: this.ownerAccountId,
      peerAccountId: requester,
      direction: "incoming",
      requestId: requestId || ("cr_in_" + this.#clock()),
      inviteCode,
      displayName: displayName || null,
      groupId: originGroupId || null,
      state: "pending",
    });
    await this.#upsertInvitedContact(requester, displayName);
    this.#emitConnectRequestUpdated(requester);
    return true;
  }

  /**
   * Auto-reconnect a requester we ALREADY hold as an active contact (their side
   * lost us and re-invited). Mirrors approveConnectRequest minus the prompt and
   * the request bookkeeping (there is no incoming request to store/clear — we
   * never surfaced one). `forceReestablish` re-keys our still-healthy link so a
   * handshake actually reaches them; a plain accept would be idempotent and send
   * nothing. The SAME peerLinkId is reused, so our DM thread + history survive,
   * and the connect-accepted signal is what resolves THEIR side (the reused-link
   * snapshot can't — it carries a stale activeInviteId).
   */
  async #autoReconnectActiveRequester(requester, inviteCode) {
    const invitesService = this.bus.services && this.bus.services.invites;
    if (!invitesService || typeof invitesService.acceptInvite !== "function") {
      this.logger.warn("[ServerContactsService] auto-reconnect: invites service unavailable for " + requester);
      return;
    }
    const acceptorDisplayName = this.#ownDisplayName();
    await invitesService.acceptInvite({ inviteCode, acceptorDisplayName, forceReestablish: true });
    await this.#announceConnectAccepted(requester, acceptorDisplayName);
  }

  /**
   * Our own display name, for the connect-accepted signal we ship to a peer. The
   * peer may already know our name (e.g. a shared group), so an empty string is
   * tolerable — it simply won't backfill — but we send it when we have it.
   */
  #ownDisplayName() {
    const profile = this.bus.services && this.bus.services.profile;
    if (profile && typeof profile.getOwn === "function") {
      const own = profile.getOwn();
      if (own && typeof own.displayName === "string" && own.displayName.trim()) {
        return own.displayName.trim();
      }
    }
    return "";
  }

  /**
   * approveConnectRequest: accept the peer's pending invite, which runs X3DH,
   * mints the durable DM peer-link, and flips the `invited` contact to `active`
   * via the existing acceptInvite contact-ensure path. Drops the request row.
   */
  async approveConnectRequest(payload = {}) {
    const peerAccountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
    if (!peerAccountId) {
      throw new Error("approveConnectRequest: accountId required");
    }
    this.#requireConnectRequestStore();
    const request = await this.#connectRequestStore.get({ ownerAccountId: this.ownerAccountId, peerAccountId });
    if (!request || request.direction !== "incoming" || !request.inviteCode) {
      const err = new Error("approveConnectRequest: no pending incoming request for this peer");
      err.code = "NO_PENDING_REQUEST";
      throw err;
    }
    const invitesService = this.bus.services && this.bus.services.invites;
    if (!invitesService || typeof invitesService.acceptInvite !== "function") {
      throw new Error("approveConnectRequest: invites service unavailable");
    }
    const acceptorDisplayName = typeof payload.acceptorDisplayName === "string" ? payload.acceptorDisplayName.trim() : "";
    await invitesService.acceptInvite({ inviteCode: request.inviteCode, acceptorDisplayName });
    await this.#connectRequestStore.delete({ ownerAccountId: this.ownerAccountId, peerAccountId });
    this.#emitConnectRequestUpdated(peerAccountId);
    // Approval alone should give BOTH sides a conversation with a starter row,
    // even if neither types anything. acceptInvite already created our (the
    // approver's) direct thread; drop the local "connect.accepted" system row
    // into it, then fire the one-shot trigger to the requester so the same row
    // appears on their side (and materializes their thread — see
    // ChatConnectAcceptedPayloadV1 + the direct-content delivery gate).
    await this.#announceConnectAccepted(peerAccountId, acceptorDisplayName);
    return { status: "approved", peerAccountId };
  }

  /**
   * Post our own "connect.accepted" system row and signal the requester. Best
   * effort: a failed signal must not fail the approval (the contact is already
   * active locally), but it IS logged so a silent drop is visible.
   */
  async #announceConnectAccepted(peerAccountId, acceptorDisplayName) {
    const threadsService = this.bus.services && this.bus.services.threads;
    const now = this.#clock();
    if (threadsService && typeof threadsService.listDirectThreadIdsForPeer === "function"
        && typeof threadsService.persistConnectAcceptedSystemMessage === "function") {
      const threadIds = await threadsService.listDirectThreadIdsForPeer(peerAccountId).catch(() => []);
      const threadId = Array.isArray(threadIds) && threadIds.length > 0 ? threadIds[0] : "";
      if (threadId) {
        await threadsService.persistConnectAcceptedSystemMessage({
          threadId,
          acceptorAccountId: this.ownerAccountId,
          acceptorDisplayName,
          actedAtMs: now,
        });
      } else {
        this.logger.warn("[ServerContactsService] connect-accepted: no direct thread for " + peerAccountId + " after approve");
      }
    }
    const signal = new ChatConnectAcceptedPayloadV1({
      senderAccountId: this.ownerAccountId,
      acceptorDisplayName: acceptorDisplayName || undefined,
      actedAtMs: now,
    });
    await this.#sendSealed(peerAccountId, signal).catch((err) => {
      this.logger.warn("[ServerContactsService] connect-accepted signal send failed",
        err && err.message ? err.message : err);
    });
  }

  /**
   * Requester side: the peer we connect-requested has approved. By the time
   * this dispatches, the direct-content delivery gate has already verified our
   * pending OUTGOING request, activated the contact, and resolved/created our
   * direct thread (ctx.threadId). Persist the matching "connect.accepted"
   * system row so our conversation opens with the same starter the approver
   * sees. Returns true (consumed) regardless, so the trigger never renders as a
   * bubble; a missing thread is logged, not fatal.
   */
  async handleIncomingConnectAccepted(record, { senderAccountId, threadId = "" } = {}) {
    const acceptor = typeof senderAccountId === "string" ? senderAccountId.trim() : "";
    if (!acceptor) {
      this.logger.warn("[ServerContactsService] connect-accepted without authenticated sender; dropping");
      return true;
    }
    const threadsService = this.bus.services && this.bus.services.threads;
    let resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!resolvedThreadId && threadsService && typeof threadsService.listDirectThreadIdsForPeer === "function") {
      const threadIds = await threadsService.listDirectThreadIdsForPeer(acceptor).catch(() => []);
      resolvedThreadId = Array.isArray(threadIds) && threadIds.length > 0 ? threadIds[0] : "";
    }
    if (!resolvedThreadId || !threadsService || typeof threadsService.persistConnectAcceptedSystemMessage !== "function") {
      this.logger.warn("[ServerContactsService] connect-accepted: no direct thread resolved for " + acceptor);
      return true;
    }
    const acceptorDisplayName = record && typeof record.acceptorDisplayName === "string" ? record.acceptorDisplayName : "";
    const actedAtMs = record && Number.isFinite(record.actedAtMs) ? record.actedAtMs : this.#clock();
    // Apply the approver's display name to OUR contact for them. When we were
    // already group co-members, accepting our direct invite REUSES the existing
    // co-member peer-link, so no peer-link "established" snapshot fires on our
    // side — the path that normally carries remoteDisplayName is skipped, and the
    // contact would activate nameless. This authenticated signal is the only
    // carrier of the approver's name. Gate on an existing relationship (a pending
    // outgoing request, or an already-active contact) so an unsolicited
    // connect-accepted cannot mint a contact.
    if (acceptorDisplayName && acceptorDisplayName.trim()) {
      const named = await this.acceptOutgoingConnectRequest(acceptor, { displayName: acceptorDisplayName })
        .catch(() => false);
      if (!named) {
        const existing = await this.#contactStore.get({ ownerAccountId: this.ownerAccountId, accountId: acceptor })
          .catch(() => null);
        if (existing && String(existing.relationshipState || "").toLowerCase() === "active") {
          await this.ensureActiveContact({ accountId: acceptor, displayName: acceptorDisplayName }).catch((err) => {
            this.logger.warn("[ServerContactsService] connect-accepted name apply failed",
              err && err.message ? err.message : err);
          });
        }
      }
    }
    await threadsService.persistConnectAcceptedSystemMessage({
      threadId: resolvedThreadId,
      acceptorAccountId: acceptor,
      acceptorDisplayName,
      actedAtMs,
    });
    return true;
  }

  /**
   * denyConnectRequest: silently drop the pending incoming request and remove
   * the `invited` placeholder contact (only if still pending — never an active
   * contact). The requester is NOT notified; their short-TTL invite expires.
   */
  async denyConnectRequest(payload = {}) {
    const peerAccountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
    if (!peerAccountId) {
      throw new Error("denyConnectRequest: accountId required");
    }
    this.#requireConnectRequestStore();
    const result = await this.#connectRequestStore.delete({ ownerAccountId: this.ownerAccountId, peerAccountId });
    const contact = await this.#contactStore.get({ ownerAccountId: this.ownerAccountId, accountId: peerAccountId });
    if (contact && contact.relationshipState === "invited") {
      await this.#contactStore.delete({ ownerAccountId: this.ownerAccountId, accountId: peerAccountId });
      // Removal event drives the client store; without it the deny path used to
      // hand-patch the renderer's contact list, which never propagated and was
      // the wrong layer to own the mutation.
      this.#emitContactRemoved(peerAccountId);
    }
    this.#emitConnectRequestUpdated(peerAccountId);
    return { status: "denied", peerAccountId, deleted: Boolean(result && result.deleted) };
  }

  /**
   * Resolve an OUTGOING connect-request because the peer has ACCEPTED it. The
   * proof is the peer's first authenticated direct content arriving over the
   * now-established link (the caller is the direct-content delivery gate, which
   * only ever sees content the peer could not have sent before accepting).
   *
   * Why the requester resolves here and not on the peer-link "established"
   * snapshot: when we were already group co-members, accepting our direct invite
   * REUSES the existing co-member peer-link, so the snapshot carries the original
   * co-member invite id — not our direct invite — and #shouldMaterializeDirectLink
   * cannot recognize it, leaving the contact stuck `invited` and the peer's DMs
   * dropped as "non-contact". Inbound direct content is a sound acceptance signal
   * that a heartbeat/recovery snapshot is not, which is exactly why resolving on
   * content (here) does not reintroduce the premature-DM-thread bug that the
   * snapshot gate guards against.
   *
   * Flips the `invited` placeholder to `active` and drops the request row.
   * Returns true only when a pending OUTGOING request existed and was activated.
   */
  async acceptOutgoingConnectRequest(accountId, { displayName = "" } = {}) {
    const id = typeof accountId === "string" ? accountId.trim() : "";
    if (!id || !this.#connectRequestStore) return false;
    const request = await this.#connectRequestStore.get({ ownerAccountId: this.ownerAccountId, peerAccountId: id });
    if (!request || request.direction !== "outgoing"
        || String(request.state || "").toLowerCase() !== "pending") {
      return false;
    }
    const name = typeof displayName === "string" ? displayName.trim() : "";
    await this.ensureActiveContact({ accountId: id, displayName: name });
    await this.#connectRequestStore.delete({ ownerAccountId: this.ownerAccountId, peerAccountId: id });
    this.#emitConnectRequestUpdated(id);
    return true;
  }

  async listConnectRequests() {
    if (!this.#connectRequestStore) return { items: [] };
    const items = await this.#connectRequestStore.listAll({ ownerAccountId: this.ownerAccountId });
    return { items };
  }

  #requireConnectRequestStore() {
    if (!this.#connectRequestStore) {
      throw new Error("ServerContactsService: connectRequestStore not configured");
    }
  }

  async #upsertInvitedContact(accountId, displayName) {
    const trimmedName = typeof displayName === "string" ? displayName.trim().slice(0, 64) : "";
    const existing = await this.#contactStore.get({ ownerAccountId: this.ownerAccountId, accountId });
    // Never downgrade an active/blocked relationship to invited. A `known` row is
    // name-only (a verified co-member, no relationship), so connect-requesting
    // them is a relationship FORMING — known → invited is an upgrade, not a
    // downgrade. (displayName: trimmedName || undefined below preserves the
    // verified known name when the request carries none.)
    if (existing && (existing.relationshipState === "active" || existing.relationshipState === "blocked")) return;
    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId,
      patch: {
        relationshipState: "invited",
        displayName: trimmedName || undefined,
      },
    });
    this.#emitContactUpdated(result && result.contact ? result.contact : null);
  }

  async #sendSealed(peerAccountId, payload) {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh || typeof sdk.mesh.dispatch !== "function") {
      throw new Error("requestConnect: sdk seal/dispatch unavailable (no live peer-link?)");
    }
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
    const sealed = await sdk.sealForPeer({ peerAccountId, plaintextBodyBytes: bodyBytes });
    await sdk.mesh.dispatch(sealed.object, sealed.address);
  }

  #emitConnectRequestUpdated(peerAccountId) {
    if (typeof peerAccountId !== "string" || !peerAccountId.trim()) return;
    this._emit("connectRequest.updated", new ConnectRequestUpdatedEvent({ peerAccountId }));
  }

  #emitContactUpdated(contact) {
    if (!contact || typeof contact !== "object") return;
    this._emit("contact.updated", new ContactUpdatedEvent({ contact }));
  }

  #emitContactRemoved(accountId) {
    const id = typeof accountId === "string" ? accountId.trim() : "";
    if (!id) return;
    this._emit("contact.removed", new ContactRemovedEvent({ accountId: id }));
  }
}
