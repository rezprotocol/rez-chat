import { RRecord } from "@rezprotocol/sdk/client";
import { nonEmptyString, toFiniteNumber } from "./coerce.js";

/**
 * AutoMintedInvite: a durable marker that WE minted this invite ourselves, as
 * machinery, rather than a person asking to form a relationship.
 *
 * Why this exists (rez-chat#10 / GHSA-pqxm-v42c-xr8f). Peer-link recovery
 * re-uses the invite/accept path verbatim, and the SAME mechanism serves both
 * "heal a desynced DM link" and "bootstrap a co-member transport link". Every
 * such invite is minted with kind:"direct" because the wire only admits
 * kind ∈ {direct, group}. When the peer accepts, ServerEventService asks
 * "was this a direct contact invite?" to decide whether the link should become
 * VISIBLE — and a recovery invite for an INVISIBLE co-member link answered yes,
 * promoting two people who merely share a group into a 1:1 contact + DM thread.
 *
 * ServerInvitesService already had the right idea: its in-memory allow-list is
 * only populated by the user-facing mint path, so an auto-minted invite is
 * correctly absent. But that list cannot survive a restart, so it falls back to
 * reading the stored envelope's `kind` — and that fallback is what re-answers
 * yes. The fallback cannot simply be deleted: it is what lets a genuine invite,
 * minted before the app was last closed, still materialize when the peer
 * finally accepts.
 *
 * So the missing fact is not "which invites are direct" (the envelope says
 * that, honestly, for its own purposes) but "which invites did a HUMAN ask
 * for". That is what this record persists, and it is deliberately a DENY-list:
 *
 *   - a row exists  → we minted it automatically; never treat as relationship
 *                     intent, no matter what the envelope kind says
 *   - no row exists → unchanged behaviour (allow-list, then envelope fallback)
 *
 * Recording only the auto-minted case keeps every existing path byte-identical
 * and means invites minted before this shipped are not retroactively
 * misjudged.
 *
 * `expiresAtMs` mirrors the invite's own expiry and is DIAGNOSTIC ONLY. It must
 * never be read as an authorization decision, and notably it is NOT what the
 * store prunes on: an expired-but-present row still proves we auto-minted the
 * invite, and sweeping rows at invite-expiry would silently turn expiry into an
 * authorization input. Retention is measured from `createdAtMs` instead — see
 * AutoMintedInviteStore.RETENTION_MS.
 */
export class AutoMintedInvite extends RRecord {
  static type = "chat.autoMintedInvite";

  constructor(raw = {}) {
    super();
    this.inviteId = nonEmptyString(raw.inviteId);
    // Free-form provenance for debugging ("peerlink-recovery"). Never consulted
    // for a decision — presence of the row IS the decision.
    this.reason = nonEmptyString(raw.reason) || "unspecified";
    const createdAtMs = toFiniteNumber(raw.createdAtMs, Date.now());
    this.createdAtMs = createdAtMs;
    this.expiresAtMs = toFiniteNumber(raw.expiresAtMs, createdAtMs);
    this._seal();
  }

  validate() {
    this.assert(this.inviteId.length > 0, "AutoMintedInvite requires inviteId");
  }
}
