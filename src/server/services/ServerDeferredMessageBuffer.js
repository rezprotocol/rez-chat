/**
 * ServerDeferredMessageBuffer: holds decrypted group messages whose
 * authenticated sender is not YET an active member, keyed `groupId:accountId`,
 * instead of dropping them — then re-applies them when that member's
 * member.join lands. Fixes the offline race where a message is push-delivered
 * before its sender's join op, which the fail-closed group authz gate would
 * otherwise drop permanently. Bounded by key count + per-key depth (oldest
 * evicted). In-memory (the live offline path re-delivers both the message and
 * the join into the same chat-server session). See memory
 * project_offline_push_before_handshake_race.
 *
 * Extracted from ServerEventService (FLOW_AUDIT 2026-06-07 finding #8) as a
 * cohesive collaborator; behavior is unchanged.
 */
export class ServerDeferredMessageBuffer {
  #map;
  #redelivering;
  #maxKeys;
  #maxPerKey;
  #logger;

  constructor({ maxKeys = 256, maxPerKey = 64, logger = console } = {}) {
    this.#map = new Map();
    this.#redelivering = false;
    this.#maxKeys = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : 256;
    this.#maxPerKey = Number.isInteger(maxPerKey) && maxPerKey > 0 ? maxPerKey : 64;
    this.#logger = logger || console;
  }

  // True while flush() is re-applying held messages. The authz gate reads this
  // so a message that STILL fails the gate during a flush is dropped rather than
  // re-deferred (no loop).
  get redelivering() {
    return this.#redelivering;
  }

  // Hold a decrypted group message whose sender isn't an active member yet,
  // keyed by `groupId:accountId`, bounded by key count and per-key depth (oldest
  // evicted). Re-applied by flush() when the join lands.
  defer(groupId, accountId, event) {
    const key = groupId + ":" + accountId;
    let bucket = this.#map.get(key);
    if (!bucket) {
      if (this.#map.size >= this.#maxKeys) {
        const oldestKey = this.#map.keys().next().value;
        if (oldestKey) this.#map.delete(oldestKey);
      }
      bucket = [];
      this.#map.set(key, bucket);
    }
    if (bucket.length >= this.#maxPerKey) bucket.shift();
    bucket.push(event);
    if (process.env.REZ_PEERLINK_TRACE === "1") {
      this.#logger.log("[PLTRACE] gate DEFER group=" + groupId + " sender=" + accountId + " (held=" + bucket.length + ")");
    }
  }

  /**
   * Re-apply any messages deferred for `accountId` in `groupId`, now that their
   * member.join has activated them. Each held event is fed back through
   * `reapply(event)` (the same deposit path that originally deferred it). The
   * `redelivering` flag is set across the loop so a message that STILL fails the
   * gate is dropped rather than re-deferred.
   */
  async flush(groupId, accountId, reapply) {
    const gid = typeof groupId === "string" ? groupId.trim() : "";
    const acct = typeof accountId === "string" ? accountId.trim() : "";
    if (!gid || !acct) return;
    if (typeof reapply !== "function") return;
    const key = gid + ":" + acct;
    const bucket = this.#map.get(key);
    if (!bucket || bucket.length === 0) return;
    this.#map.delete(key);
    if (process.env.REZ_PEERLINK_TRACE === "1") {
      this.#logger.log("[PLTRACE] gate FLUSH group=" + gid + " sender=" + acct + " (n=" + bucket.length + ")");
    }
    this.#redelivering = true;
    try {
      for (const event of bucket) {
        try {
          await reapply(event);
        } catch (err) {
          this.#logger.error("[ServerDeferredMessageBuffer] deferred group message re-apply failed",
            err && err.message ? err.message : err);
        }
      }
    } finally {
      this.#redelivering = false;
    }
  }
}
