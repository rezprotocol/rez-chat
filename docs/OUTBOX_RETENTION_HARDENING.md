# Outbox deletion-hole containment

## Scope and outcome

The older decrypted apply-outbox no longer deletes work because its retry count
or age exceeds a bound. It retains plaintext, logs the failure, and parks the
mailbox/event pair for the current pipeline runtime. Other entries and mailboxes
continue. No dropped-message notice is emitted for retained work.

Successful application still permits ordinary outbox cleanup. Restart permits
another application attempt without decrypting the ciphertext again. Unlike the
SDK work loop's in-memory attempts, the older outbox's failure count remains
persisted; an already over-bound item receives one retry in a new runtime and
parks again if that attempt fails. Clearing the fault without restarting does
not unpark it. There is no lifetime retention cap or durable failure notice yet.

This is containment of a deletion hole, not the durable-disposition workstream's
completion. Undecryptable remote-deposit quarantine is unchanged and must not be
confused with retention of already-decrypted local work.

## Missing durable contract

Current SDK replay records admit only `ready-to-apply` and `applied`; no terminal
failure disposition exists. The chat quarantine event is a live notification,
not a persisted/acknowledged notice inbox. The permanent solution needs an
explicit SDK-owned disposition contract and chat-owned persisted notice replay.
The repository's record rule requires approval for that missing contract before
implementation; no new ad-hoc persisted shape or second work owner was added.

The acceptance invariant for that follow-up remains: durable idempotent failure
disposition before finalization, recoverable notification after reconnect, and
crash safety across every handoff. Until then, neither local retained-work loop
may delete work on a retry bound. See rezprotocol/rez-sdk#3.

## Files changed in this slice

- `src/server/runtime/InboundDepositPipeline.js`: replace old outbox bound-based
  deletion with mailbox-scoped per-runtime parking; preserve SDK retention work.
- `src/server/inbox/InboundApplyOutbox.js`: correct lifecycle documentation only.
- `src/server/services/InboxCatchupService.js`: clarify application retention vs
  event-only quarantine; no behavioral changes.
- `test/inbox.apply-outbox.pipeline.test.js`: update one deletion assertion and
  add six tests covering restart recovery, mailbox isolation, disconnected UI,
  and three real-filesystem abrupt-process-exit boundaries.
- `test/server.quarantine-floor.m5.test.js`: update two application-age tests to
  assert retention and parking; remote undecryptable-deposit tests are unchanged.
- This report.

Other pre-existing DT-302 changes remain uncommitted and were not reverted.

## Verification

- Focused pipeline/store, catch-up, M5 and System notice suites: 48 passed,
  0 failed, 0 skipped.
- Full `npm test`: production Vite/SRI build passed; 1,080 passed, 0 failed,
  3 skipped, followed by 2 passed portability tests.
- Abrupt-exit tests use separate Node processes and the real fsync-backed KV:
  exit after staging, after persisting the bound-crossing counter but before
  parking, and after parking. Each reopens the files, verifies plaintext remains,
  then applies successfully without re-decrypting. These test process failure,
  not physical power loss.
- Complete local mesh: 8 passed, 0 failed, 7 skipped, including co-member
  separation, offline accept, restart, recovery, and bidirectional group delivery.
- Diff whitespace check passed. Build retained its existing bundle-size warning.

## Focused audit

Checked root AGENTS.md, M5's approved CPU-opportunity floor, DT-006's durable
work/application ownership, the outbox's single-record persistence, catch-up's
acknowledgement gate, and the UI-only notice path. Pipeline serialization remains
the mutation boundary. Parking keys include both mailbox and event identity.

SDK remains sole owner of SDK work/replay state. Chat owns its legacy apply-outbox
and application retry policy. No new dependency, protocol, RPC, persistent schema,
cross-repository import violation, duplicate authority, or god-class expansion was
introduced. Destructive retry-bound code was removed, not moved elsewhere.
No broad architectural refactor or unrelated dead-code cleanup was performed.

Remaining limitations: parked work is invisible to the UI and needs restart to
retry; storage grows with retained failures; counter-write failures can prevent
the persisted attempt threshold from advancing (work remains retained and errors
are logged). The SDK/control-message recovery and shutdown findings from the
earlier audit are not closed by this change. Full cross-repo release packaging,
v4/v5 gates, native mobile, deployment, and release publication were not performed.
