# One message lifecycle for images — 2026-11-10

Status: implementation, focused recovery/security checks, full clean suite
and live Chrome/Firefox candidate checks pass. Public promotion pending.

## Problem and resulting ownership

Images previously bypassed normal messaging. ServerFileTransferService minted
sender and receiver IDs independently, wrote both projections/indexes, emitted
message/status events, and never invoked a recipient receipt. Bytes could be
correctly received while the sender stayed at Sent forever. The initial local
patch connecting receipts to that duplicate lifecycle was discarded before
testing, commit or deployment.

ServerMessagesService now owns `file.send`: upload/cache bytes, construct the
existing ChatImagePayloadV1, and invoke its normal sendMessage method. The same
message ID reaches both sides. ServerEventService validates referenced bytes,
uses its normal projection/index writer, and sends the existing sealed receipt
after commit. Missing bytes, projection/index failures and receipt dispatch
failures remain retryable in the existing durable apply-outbox. Sender receipt
routing is durable before external dispatch; an early receipt cannot be
overwritten by the send promise's later Sent transition.

The transfer service now handles only byte transport/cache and notifies its
consumer after verified byte completion. The message owner persists Chat-owned
manifest context. New transfers carry a normal image envelope separately;
old-format completion enters the same message apply core through a compatibility
adapter and preserves its previous receiver projection ID. Core/SDK file records
and Node wire authority are unchanged. Chat file wrappers are explicit RRecord
subclasses around the existing SDK manifest/chunk records; no app fields move
into Core. Caption and message status belong to the normal image envelope.

## Files changed

- `src/server/services/ServerMessagesService.js`: sole file-send orchestration,
  normal image message construction, compatibility ingress, durable receipt
  routing and committed status events.
- `src/server/services/ServerEventService.js`: image readiness validation at
  the normal apply boundary, shared post-commit receipt dispatch, original
  timestamp recovery and propagated index failure. Its unrelated pre-existing
  control-dispatch error change remains unstaged/excluded from the candidate.
- `src/server/services/ServerFileTransferService.js`: remove all message ID,
  projection/index/status/event writing and `file.send` registration; retain
  byte transfer/cache, typed routing context and completion notification.
- `src/server/storage/ChatThreadStore.js`: persistent scalar receipt routes,
  typed app manifest context and monotonic Delivered preservation.
- `src/records/payloads/ChatFilePayloadsV1.js`, `ChatImagePayloadV1.js`,
  payload registry, and `src/records/results/FileSendResult.js`: explicit
  app context, normal image envelope identity and byte size from the byte owner.
- Byte-only transfer tests, new `test/messages.attachments.test.js`, device
  fan-out and direct-sender-binding fixtures, one selective commit-proof test
  expectation, and hosted-web status/refresh acceptance.
- Section 13 of `CHAT_APP_SPEC.md` and this receipt.

## Verification

Focused common-message/attachment/resend/fan-out tests: **39 pass**, zero
failures/skips. Focused durable catch-up, sender authentication, signed commit
proof and generic IPC/Core boundary checks: **39 pass**, zero failures/skips.
Counts overlap. Tests prove early receipt before send returns; one canonical
image row/ID; sender refresh before delayed receipt; missing bytes; receipt
failure/restart; durable apply-outbox recovery without re-decryption; partial
index recovery under original timestamp; wrong-peer rejection; legacy ingress;
and one expected receipt per group member/message rather than per byte chunk.
The byte test fails on any message/status event from the transfer service.

The first full clean run had two failures caused by now-awaited receipt errors:
an authentication fixture lacked a working seal double, and a verified-device
failure test expected application to succeed without a return route. The
fixture and failure expectation were corrected; no security check was weakened.
Final clean full suite: **1,107 pass / zero fail / three explicitly gated
native/live integration tests not run**, plus isolated SDK portability
**2 pass**. The extra new attachment integration tests are run explicitly in
the focused suites because the default npm script enumerates test files.
Production web build and integrity injection pass; the existing bundle-size
warning remains. Core/SDK source tests were not repeated because their sources
are unchanged; the full Chat suite consumes the clean committed versions.

Live Chrome and Firefox both pass the complete workflow: offline 1.7 MB PNG
shows Sent; sender refresh discards RAM receipt maps; receiver acknowledges
and commits a first chunk, later pages are deliberately blocked; chat remains
usable and sends a message; receiver page restarts with saved storage; exact
PNG bytes and 700×700 rendering recover without consumed-page replay; the
original sender bubble changes to Delivered; reverse reply succeeds; another
sender refresh preserves Delivered. Recipient unlock-to-usable measured
**1.692 s in Chrome / 1.990 s in Firefox**. These are synthetic observations,
not guaranteed timings. No passwords, keys or browser data are cleared.
Firefox logs one socket-closed drain during the deliberate final navigation;
the required status/history/refresh assertions still pass.

Evidence:
`/tmp/rez-image-receipts-20261110/` and the isolated existing clean candidate
at `/tmp/rez-web-recovery-20261110/candidate/`.

## Required focused audit

Specs checked: `CHAT_APP_SPEC.md` section 13; root
`plans/MESSAGE_COMMIT_ACK_PLAN.md`; existing original-message admission/commit
records; file manifest/chunk/session contracts; durable apply-outbox and
contiguous consumed-cursor contracts; group expected-receipt/status split;
generic ChatBridge specification and normal UI status consumer.

Canonical owners confirmed: SDK owns byte validation/reassembly/persistence;
Chat message service owns app sends and receipt correlation; Chat event service
owns inbound projection and receipt dispatch; Chat thread store owns durable
app records; UI renders the shared events. Core protocol and Node RPC records
retain their owners. No transport facade/directive list or cross-layer import
was introduced.

Duplicate/split-brain findings: the parallel transfer-owned message lifecycle
is removed, not kept as a fallback. The legacy adapter calls the normal apply
core and has no store/index/status writer. Durable receipt routing has one
writer/reader in the existing thread store; RAM is only a cache. Boundary/SSOT
findings: app context uses typed Chat records around generic SDK records; no
protocol behavior moves to UI. Hidden transforms removed: caller-derived byte
size and independent image IDs/status; the byte owner supplies actual size and
the normal message owner mints new IDs. Invariants: receipt follows verified
bytes and message/index commit; auth sender must match the target peer;
group-member ACK is not all-member Delivered; restart does not re-decrypt.
God-class findings: message/event services remain existing orchestration owners;
the transfer class shrinks substantially. Whole-class decomposition is outside
this focused change. Dead code removed: transfer-owned send registration,
outbound/inbound projections, index/status events, ID/preview helpers, channel
map writing, and redundant post-dispatch ACK registration. Tests were aligned
to the owning layer, with actual store and apply-outbox recovery regressions.
No unresolved ownership/SSOT/boundary finding in changed code/direct dependencies.

## Limits and rollout requirements

Both web participants should refresh normally, retaining saved site data.
Already completed historical images lack a receipt and cannot be truthfully
marked Delivered retroactively. Old client binaries still own their old receive
behavior; the compatibility ingress protects reception of old-format sends in
the updated client, not the behavior of an unupdated receiver. A new sender and
old receiver can display duplicate images until the old receiver updates.

Signed text keeps the existing verified MessageCommitAck regime; image messages
remain in the existing session-authenticated non-OriginalMessage regime and
use its encrypted E2eeDeliveryAckV1. This change does not claim a new signed
image-fact protocol. Group images follow current text status policy; first
member ACK does not turn the group row Delivered. Media remains eager chunk
transfer, not on-demand network retrieval. Existing cache/unfinished-transfer
quota/retention work remains open. Legacy files with bytes lost by old clients
may need resend. Published desktop packaging/custody gates remain open; no
new native artifact is certified. iPhone and Swift sources and unrelated WIP
remain untouched. Core/SDK/Node sources are not changed in this slice.
