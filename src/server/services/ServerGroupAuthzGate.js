import { GROUP_OP_KIND } from "../../records/payloads/index.js";

/**
 * ServerGroupAuthzGate: the fail-closed authorization decision for inbound group
 * CONTENT (audit pass 5, H1). Before any group content (messages, reactions,
 * edits, tombstones, media) is dispatched/persisted/rendered, the sender MUST be
 * an active member of the target group. The only trustworthy sender identity is
 * `authedSender` — the account from the decrypted peer-link snapshot
 * (cryptographically authenticated); the payload's self-declared sender is NOT
 * trusted for group threads. Group-management ops (GroupOpPayloadV1) self-
 * authorize inside ServerGroupsService.handleIncomingGroupOp (member.join is the
 * bootstrap exception), so they are exempt.
 *
 * Extracted from ServerEventService (FLOW_AUDIT 2026-06-07 finding #8). Pure
 * decision: it performs the membership lookup and returns a verdict; the caller
 * owns the side effects (defer into the buffer, drop-with-log, or pass through).
 * Verdict.action:
 *   - "pass"  — not a gated deposit, or sender is an active member; proceed.
 *   - "defer" — brand-new authenticated sender with NO membership record yet
 *               (their member.join hasn't been processed); hold, don't drop.
 *   - "drop"  — unauthenticated sender, or a non-active (e.g. removed/kicked)
 *               membership; fail closed.
 */
export class ServerGroupAuthzGate {
  #groupStore;
  #ownerAccountId;

  constructor({ groupStore, ownerAccountId } = {}) {
    if (!groupStore) throw new Error("ServerGroupAuthzGate requires a groupStore");
    this.#groupStore = groupStore;
    this.#ownerAccountId = ownerAccountId;
  }

  /**
   * @param {object} thread        resolved target thread (may be null)
   * @param {string} inboundKind   payload kind (group ops are exempt)
   * @param {string} authedSender  cryptographically-authenticated sender id
   * @param {boolean} redelivering true while the deferred buffer is flushing
   *   (a message that still fails the gate during a flush must drop, not re-defer)
   * @returns {Promise<{action: "pass"|"defer"|"drop", groupId: string}>}
   */
  async evaluate({ thread, inboundKind, authedSender, redelivering } = {}) {
    if (!(thread && thread.threadType === "group" && inboundKind !== GROUP_OP_KIND)) {
      return { action: "pass", groupId: "" };
    }
    const groupId = typeof thread.groupId === "string" ? thread.groupId.trim() : "";
    const sender = typeof authedSender === "string" ? authedSender.trim() : "";
    const membership = groupId && sender
      ? await this.#groupStore.getMembership({
          ownerAccountId: this.#ownerAccountId,
          groupId,
          accountId: sender,
        }).catch(() => null)
      : null;
    if (membership && String(membership.state || "").toLowerCase() === "active") {
      return { action: "pass", groupId };
    }
    // Defer ONLY a brand-new authenticated sender we have NO membership record
    // for yet (their member.join simply hasn't been processed). A sender whose
    // membership exists but is non-active (e.g. "removed"/kicked) is NOT a
    // pending joiner — drop it, so a later re-admission can never resurrect a
    // message they sent while removed.
    if (!membership && sender && groupId && !redelivering) {
      return { action: "defer", groupId };
    }
    return { action: "drop", groupId };
  }
}
