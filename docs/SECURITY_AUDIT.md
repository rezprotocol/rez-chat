# rez-chat Security Audit Log

Adversarial review of the chat-layer trust boundaries. Each pass records the
findings, their disposition, and the regression tests that lock the fix in.

> Earlier protocol/identity/E2EE/DHT passes (1–4) are tracked in the rez-core /
> rez-node / rez-sdk histories. This file covers the **group-chat** surface.

---

## Pass 5 — Group membership & content authorization (2026-06-02)

### Threat model

A decentralized E2EE group has no central server to arbitrate membership. Each
member's node independently decides who is in a group and whose content to
render. The adversary is a **current, former, or malicious group member** (or
any peer holding an established peer-link to a member) who tries to: re-enter a
group after being kicked, inject or impersonate content, add phantom members,
escalate to admin, or bypass invite limits. A peer-link **survives a kick**, so
"keep the client running after being removed" is the baseline attacker.

### Root cause

Group security rested on only two things: an E2EE peer-link existing, and
clients behaving. There was **no authoritative "is this sender an active member
of this group?" check** on inbound content, and membership could be (re)granted
as a side effect of unauthenticated paths.

### Findings & fixes

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| **H1** | High | Inbound group messages were persisted/rendered with no membership check; the persisted sender was the **payload-declared** (spoofable) id; receiving a message auto-created/restored membership (`ensureMembership`), so a kicked member could re-inject content and re-add themselves. | `ServerEventService` now drops group content whose **authenticated** sender (the decrypted peer-link snapshot identity) is not an active member; uses the authenticated sender for persistence; no longer (re)establishes membership on message receipt. |
| **H2** | High | The acceptor stamped the **inviter** as the group's `createdBy`; the founder rule (`createdBy → effective admin`) then made the inviter permanent admin over the invitee — even after demotion / if never an admin. `createInvite` was ungated, so anyone could mint an invite for any group. | The group's **true founder** is carried (signed) in the invite envelope (`groupCreatedBy`) and used as `createdBy` on accept. `createInvite` (group) now requires the creator to be an active member. |
| **M3** | High | `member.join` authorization checked only that the invite existed + groupId matched — **no expiry, no maxUses, no revocation**. maxUses was bypassable once a peer-link existed (no fresh handshake → no enforcement). | New `PeerLinkService.authorizeInviteJoin` enforces expiry + maxUses against the same `acceptedAcceptors` ledger as the handshake responder (single source of truth); the self-announce `member.join` path calls it. |
| **M4** | Med | A forwarded `member.join` was honored on the forwarder's membership alone — a single member could inject arbitrary members, including resurrecting kicked ones. | Forwarded joins may **add a new** member but can **never revive a removed** one; revival is only reachable via the inviter's freshness-gated self-announce. |
| **M5** | Med | Group message **mutations** (reactions/edits/tombstones) were applied with no membership check. | Covered by the H1 gate (all non-`member.join` group content requires active membership). |

### Kicked-then-reinvited (done securely)

Re-admitting a removed member is a privileged, explicit transition
(`ChatGroupStore.reviveMembership`), never a side effect of `ensureMembership`.
It is authorized by the **anti-resurrection rule**: at the inviter's
self-announce handler, a removed member is re-admitted only if the invite's
signed `createdAtMs` is **after** that member's removal time. This comparison is
clock-safe because the inviter stamps both timestamps on its own clock; a stale
invite predating the kick cannot undo it. Forwarded recipients trust the
inviter's decision (the existing forward trust model).

### Verified NOT exploitable (so we didn't over-build)

- **Group-op replay (setRole/kick/rename).** The Double Ratchet
  (`rez-core` `RatchetService`) consumes each message key once and rejects a
  re-presented chain position, so captured ciphertext can't be replayed and a
  third party can't re-encrypt an old op. A demoted admin replaying their own op
  also fails (no current key; dropped as non-admin). App-layer `groupOpId` dedup
  remains a defense-in-depth nicety, not a live vuln.
- **LWW future-timestamp rename / kick-not-yet-propagated forward race** —
  require admin / bounded eventual-consistency windows; low.

### Creator role + cryptographic founder binding (takeover prevention + H2 closure)

Two follow-ups completed the privilege model:

- **Un-removable `creator` role.** The founder is now a distinct `creator`
  role (above `admin`), identified by `group.createdBy`. The creator **cannot be
  kicked or demoted, and no one else can be made creator** — enforced on both
  the action side (`kickMember`/`setMemberRole`) and, authoritatively, on every
  receiving node (`#applyIncomingKick`/`#applyIncomingSetRole`, keyed on each
  node's own `createdBy`). This closes the takeover where a promoted admin kicks
  the founder (→ removed → loses the founder-rule authority) and seizes control.
- **`createdBy` ↔ `groupId` binding.** `groupId` is now derived as
  `hash(createdBy + ":" + creatorSalt)`; the salt is carried (signed) in group
  invites, and the acceptor **verifies** `groupId === hash(groupCreatedBy +
  ":" + groupSalt)` before trusting the founder (fail closed). A malicious
  inviter can no longer self-stamp as creator — they cannot produce a
  `(createdBy, salt)` pair that hashes to a group they did not found. **This
  closes the H2 residual** and makes the creator role's identity unforgeable.

### Residual / accepted

- A not-yet-readmitted rejoiner's optimistic local thread unlock is cosmetic:
  peers drop their content via the H1 gate until they are authoritatively
  re-admitted.
- Ownership **transfer** is not supported (the creator is fixed = founder).
  Deferred until there's a product need; would require a signed transfer op.

### Regression tests

- `test/server.group-message-authz.test.js` — H1: active-member accepted;
  non-member dropped; kicked member can't inject; sender-spoof defeated.
- `test/server.member-join.test.js` — M3/M4/anti-resurrection: unauthorized
  join dropped; stale-invite cannot resurrect, fresh post-kick invite re-admits;
  forwarded join cannot resurrect.
- `test/server.invites.offline-inviter.e2e.test.js` — `authorizeInviteJoin`
  expiry + maxUses against real invite records (un-mocked crypto).
- `test/server.group-creator.test.js` — creator can't be kicked/demoted (action
  + inbound); no second creator can be minted; founder shown as creator.
- `test/server.invites.accept.test.js` — H2: true founder stamped + verified
  against the groupId; forged founder binding rejected; non-member invite
  rejected.
