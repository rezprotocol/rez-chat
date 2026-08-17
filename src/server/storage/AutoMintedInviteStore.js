import { asInt, requireId } from "./coerce.js";
import { KvTable } from "./KvTable.js";
import { AutoMintedInvite } from "../../records/domain/AutoMintedInvite.js";

// Prune ceiling. Auto-minted invites are already rate-limited at the mint site
// (per-peer cooldown + a global cap per rolling window), so this is a backstop
// against unbounded growth on a long-lived install, not a load-bearing limit.
const MAX_ROWS = 4096;
// How long provenance is retained, measured from when WE minted the invite.
//
// Deliberately NOT the invite's own expiry. Pruning on expiry would quietly
// make expiry an authorization input: the moment the row is swept, a late
// accept reads as human-minted again and the co-member link materializes — the
// exact defect this store closes. Retention must therefore outlive any accept
// that could still succeed. Recovery invites live ~5 minutes, so 24h is ~288x
// the window and leaves no realistic race, while still bounding growth.
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * AutoMintedInviteStore: durable deny-list of invites this node minted itself
 * as machinery (peer-link recovery / co-member bootstrap) rather than because
 * a person asked to connect. See AutoMintedInvite for why the distinction
 * exists and why it must survive a restart.
 *
 * Keyed by inviteId alone under an owner scope: an inviteId is already unique
 * per mint, and the only question ever asked is "did we auto-mint this one".
 */
export class AutoMintedInviteStore {
  constructor({ storageProvider, clock = () => Date.now() } = {}) {
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("AutoMintedInviteStore requires storageProvider.getKeyValueStore()");
    }
    if (typeof clock !== "function") {
      throw new Error("AutoMintedInviteStore requires clock function");
    }
    this.kv = storageProvider.getKeyValueStore(null);
    this.clock = clock;
    this.invites = new KvTable({
      kv: this.kv,
      prefix: "app:autoMintedInvites/",
      record: AutoMintedInvite,
      label: "AutoMintedInviteStore",
      clock,
    });
  }

  /**
   * Record that we auto-minted `inviteId`. Callers MUST await this BEFORE the
   * invite leaves the node: if the marker is not durable by the time the peer
   * can accept, the accept races the write and the link may materialize as a
   * visible contact — the exact defect this store closes.
   */
  async markAutoMinted({ ownerAccountId, inviteId, reason = "unspecified", expiresAtMs = null } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const id = requireId(inviteId, "inviteId");
    const now = asInt(this.clock(), Date.now());
    const row = this.invites.coerce({
      inviteId: id,
      reason,
      createdAtMs: now,
      expiresAtMs: asInt(expiresAtMs, now),
    });
    if (!row) {
      throw new Error("AutoMintedInviteStore.markAutoMinted produced invalid row");
    }
    await this.invites.set(row, owner, id);
    await this.#prune(owner, now);
    return row;
  }

  /**
   * True when we minted this invite ourselves. Deliberately IGNORES expiry: an
   * expired row still proves provenance, and treating a stale row as "not
   * auto-minted" would reopen the defect for any accept that arrives late.
   *
   * Fail-CLOSED on a storage fault. A read error means we cannot prove a human
   * asked for this invite, and the cost of the two answers is asymmetric:
   * wrongly reporting auto-minted hides a contact the user can re-create with
   * an explicit connect-request, while wrongly reporting human-minted leaks a
   * co-member into their contact list. Never silently swallow the fault.
   */
  async isAutoMinted({ ownerAccountId, inviteId } = {}) {
    const owner = requireId(ownerAccountId, "ownerAccountId");
    const id = requireId(inviteId, "inviteId");
    let row = null;
    try {
      row = await this.invites.get(owner, id);
    } catch (err) {
      const wrapped = new Error(
        "AutoMintedInviteStore.isAutoMinted: storage read failed, failing closed: "
          + (err && err.message ? err.message : String(err)),
      );
      wrapped.cause = err;
      wrapped.code = "AUTO_MINTED_LOOKUP_FAILED";
      throw wrapped;
    }
    return Boolean(row);
  }

  /**
   * Drop rows older than RETENTION_MS, then oldest-first once over MAX_ROWS.
   * Age is measured from OUR mint time, never from the invite's expiry — see
   * RETENTION_MS. Never prunes the row just written.
   */
  async #prune(ownerAccountId, nowMs) {
    const all = await this.invites.list(ownerAccountId);
    const stale = all.filter((row) => nowMs - row.createdAtMs > RETENTION_MS);
    for (const row of stale) await this.invites.delete(ownerAccountId, row.inviteId);
    const live = all.length - stale.length;
    if (live <= MAX_ROWS) return;
    const staleIds = new Set(stale.map((row) => row.inviteId));
    const ordered = all
      .filter((row) => !staleIds.has(row.inviteId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    const surplus = ordered.slice(0, live - MAX_ROWS);
    for (const row of surplus) await this.invites.delete(ownerAccountId, row.inviteId);
  }
}
