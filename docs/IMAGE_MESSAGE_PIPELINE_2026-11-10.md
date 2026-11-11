# One message lifecycle for images — 2026-11-10

Latest: the November 11 file-drop and first-member group-delivery update is
committed, pushed on `feat/hosted-cluster`, and deployed. See the final release
record below; earlier local-status notes are historical.

Status: committed, pushed and publicly deployed **November 10, 2026 at
6:20 p.m. America/Chicago** (2026-11-11 00:20:09 UTC). Implementation, focused
recovery/security checks, full clean suite and live Chrome/Firefox checks pass.

Implementation commit: `48c362e` on `feat/hosted-cluster`. Release:
`/opt/rez/releases/web-images-20261110/`; entry script
`assets/index-Cck_MLEC.js`; entry SHA-256
`138e0d149d410170d3c11e022b61c33eec38c91dc59c21421fe5f4ce6c9145cb`.
Staged implementation/test files were byte-compared to the clean candidate.
The server verified artifact hashes, preserved the previous entry/old hashed
assets for rollback, promoted the entry atomically, fetched the public page
and compared it to the verified artifact. `/ready` reports storage/Redis
healthy with no degradation. The temporary public test HTML was removed.
No Node/relay deployment or storage reset was needed.

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

Complete candidate workflow: Chrome **45.4 s**, Firefox **44.7 s**, one test
each with zero failures/skips. Post-promotion public Firefox repeats the entire
Delivered/refresh/interrupted-image proof in **43.9 s**, zero failures/skips;
recipient unlock-to-usable **1.875 s**. These checks overlap rather than adding
distinct coverage counts. Core/SDK/Node original working-diff hashes match the
pre-task snapshots; Chat's unrelated diff and original edits in both mixed
source/test files are preserved. No iPhone/Swift source was edited or staged.

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

## November 11 follow-up: browser diagnosis and local UI changes

The user's open Firefox tab visibly rendered the same image bytes under two
different message IDs: one `img_recv_…` legacy completion row and one `local_…`
normal message. Its console logged `unknown payload kind rez.image.v1` and its
loaded entry was `index-C6SbI2X8.js`. A read of the currently published shell
returned `index-BZ2AiNEI.js`. This confirms an older receiver was running both
the legacy completion projection and the new sender's normal image envelope.
The tab was refreshed, preserving site data; the user unlocked it again.
The friend was offline, so confirmation used three independent QA browser
accounts on the real hosted network, as explicitly requested by the user.
Existing saved duplicate rows were not deleted or combined by content hash:
repeated intentional sends of identical bytes must remain distinct messages.

The following changes are **local and uncommitted, not published**:

- `src/ui/views/ThreadPanelView.js`: file drag/drop capture across the active
  chat window, including the sidebar; prevent file navigation, respect the
  writable composer state, and remove window listeners on unmount.
- `src/ui/views/ComposerView.js`: share picker/drop staging, reject multiple
  files explicitly, retain the 10 MiB limit, invalidate stale file reads on
  conversation changes/unmount, and block disabled sends.
- `src/server/services/ServerMessagesService.js`: persist unsigned group
  receipt correlation before dispatch; accept an authenticated active member's
  post-commit receipt as Delivered. Signed group text still requires a valid
  commit proof naming the exact authored fact. Self/non-members and legacy
  acknowledgements for signed facts do not qualify. Shared recipient checking
  and delivery-status application replace duplicated handlers.
- `src/ui/views/MessageBubbleView.js`: group Delivered title/accessibility text
  explains "at least one group member". It does not imply read or all-member
  receipt. `ServerEventService.js` only updates the associated policy comment;
  its pre-existing control-dispatch change is preserved.
- `docs/CHAT_APP_SPEC.md` and root `plans/MESSAGE_COMMIT_ACK_PLAN.md`: document
  the user's explicit first-member decision, superseding the prior DT-004
  status policy. N-member retry/count semantics remain out of scope.
- `test/messages.attachments.test.js`, `test/delivery-ack.roundtrip.test.js`,
  `test/server.message-commit-ack.test.js`: group image replay/restart coverage,
  delayed receipt after sender refresh, partial-group confirmation, signed
  proof/non-member/bad-signature checks, and the updated group status assertion.
  Existing unrelated edits in the signed-proof test are preserved.
- `test/e2e.local-mesh.group-three.test.js`: extend the existing real three-leaf
  relay test with first-member delivery while Carol is offline, image catch-up
  after restarting Carol, exact-byte/shared-ID checks and a second intentional
  send of identical image bytes. Preserve its pre-existing bootstrap changes.
- `scripts/qa-chat-attachments.mjs` and
  `test/support/chatAttachmentUiFixture.js`: isolated browser checks using real
  stores/views and native File/DataTransfer objects; no network messages or
  real account data. These browser checks are run explicitly.

Verification: **127 focused Node tests pass, zero failures/skips**, across
attachment, delivery/commit acknowledgement, resend, mutation, device fan-out,
group authorization, storage, message-store, summary, IPC, view and Core-import
boundary checks. Browser checks pass for whole-window drops, explicit Send,
multiple-file rejection, size limit, stale reads after conversation switching,
disabled threads, overlay cleanup, listener cleanup and group status wording.
The styled fixture also asserts that its application styles loaded.
`git diff --check` passes. The extended real local three-account mesh test also
passes (one test, 11.3 seconds, zero failures/skips). Full repository/native and
the remaining live-mesh suites were not run.

Three real browser accounts also pass using the production-built candidate
`index-CaoV-Ws_.js`, isolated origins `127.0.0.1:5191`/`:5192`/`:5193` and the
real hosted `wss://chat.rezprotocol.io/ws` network. Alice creates the group,
invites Bob, and Bob invites Carol; Alice's roster shows all three. Carol's
tab is closed before Alice sends a 115.5 KB, 256-pixel PNG. Alice and Bob each
render exactly one decoded image with the same message ID, and Alice shows
Delivered before Carol reopens. Bob refreshes; Carol reopens/unlocks and
catches up: each still renders exactly one image with the sender's ID. Alice
intentionally sends the identical file a second time: every browser renders
exactly two decoded images, with the same two IDs across all accounts. Bob's
group text reaches Delivered too. Alice then refreshes/unlocks: both image
rows remain Delivered and only the two intentional images are rendered.
This is real UI/crypto/network/storage validation, not the synthetic UI fixture
or mocked send dispatch. Only disposable QA accounts were used; the user
explicitly approved acknowledging their recovery prompts. No recovery words
were retained for use. No messages were sent from the user's account.

The working-checkout production build fails because previously deleted
`rez-ui/branding/filled-silhouette/rez-icon-mark-notification.png` is missing;
other branding and the icon font were also already deleted. A temporary copy
of the current sources with four tracked branding/font files restored from
HEAD builds successfully and passes integrity injection. No asset was restored
in the user's checkout. Existing bundle-size and Node transport externalization
warnings remain. Evidence/logs: `/tmp/rez-chat-tweaks-focused.log`,
`/tmp/rez-chat-tweaks-direct-deps.log`, `/tmp/rez-chat-tweaks-build.log`,
`/tmp/rez-chat-tweaks-isolated-build.log`,
`/tmp/rez-chat-tweaks-live-group.log`; candidate
`/tmp/rez-chat-ui-check-SkkP69/`.

Focused audit: checked Chat spec sections 8/13, commit-ack plan, DT-004 history,
Chat file wrappers/payload registry, group membership, thread status/idempotency
storage and direct UI/service dependencies. Canonical owners remain SDK for
generic bytes/crypto, Chat services for message/status/receipt semantics, Chat
stores for persistence, and views for DOM/drop presentation. No new protocol
record, cross-layer import, dependency or transport directive was added.
No new split-brain/SSOT/boundary or mixed-responsibility finding remains in
touched code. Existing large message/event services were not decomposed or
audited in full. Removed dead/superseded paths: duplicate delivery-status
application and obsolete group-status exclusions/comments. No byte-transfer
projection writer or hash-based message deduplication was introduced. No
implementation/spec drift remains against the updated user-approved policy.

Remaining limits: current active membership is required when a receipt arrives;
a removed member's late receipt is ignored. Signed text stays Sent if a member
cannot provide valid proof. There is no all-member delivery count/retry loop.
Old open tabs must refresh to run current image handling; already stored
duplicate messages remain. The drop/status changes still require publication
and acceptance in the hosted app. No commit, push, master merge or deployment
was performed.

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

## November 11 browser release — deployed

Implementation commit: `5a9ea750bbb729a2ec9a3272ce5a08e0e48ac467` on
`feat/hosted-cluster`, pushed to origin. Public promotion completed at
**3:29:26 p.m. America/Chicago on November 11, 2026**
(`2026-11-11T21:29:26Z`). No merge into or push to `master` occurred.

Release: `/opt/rez/releases/web-chat-groups-20261111T211203Z/`.
Public script: `/assets/index-CEPI9pYF.js`. Public entry SHA-256:
`608cdc68b604b99b66f5a3b5356b6004a046c741e43c0c20aac6e38338d9f47d`.
The previous entry and old assets remain available for rollback. Nineteen
artifact files were checked before staging; public HTML was promoted atomically
only after checking the previous entry for drift. External fetches matched
both the tested HTML and JavaScript bytes. Three public readiness samples
from 21:30:10Z through 21:30:31Z reported `ok=true`, `degraded=false`, with
storage and Redis healthy. The public browser root loaded the new script
without console errors. The temporary candidate HTML was removed afterward.

The release was rebuilt from clean HEAD archives of Core, SDK, Node, UI and
Chat plus exactly this task's selected changes, including selective hunks in
the three mixed files. Every one of the thirteen selected candidate files
was compared byte-for-byte with the implementation commit. Unrelated storage,
identity, preview, packaging, test-fixture work and existing file deletions
remain outside the commit and deployment. The deleted branding/font assets
were available from HEAD in the temporary build snapshot; the checkout was
not restored. The root `plans/MESSAGE_COMMIT_ACK_PLAN.md` policy update remains
in the non-Git workspace; the same decision is committed in `CHAT_APP_SPEC.md`.

Final verification: the clean-source normal suite passed **1,119 tests**,
with three pre-existing gated desktop/live tests unrun, followed by **2/2 SDK
portability tests**. The clean three-account relay test passed, including
first-member Delivered with Carol offline, restart catch-up, matching IDs and
exact bytes, and two intentional sends producing exactly two rows per account.
After the final picker change, 41 focused receipt/architecture checks passed
and the production build with integrity injection passed. The default full
runner initially stalled; the successful full run used four files at a time.
Missing SQLite native bindings initially failed desktop checks; the same
existing dependency version (12.11.1) from a previously built candidate was
reused only in the temporary snapshot, after which all active tests passed.
No dependency or tooling configuration was added or changed.

Fresh browser origins using the exact final release build and real hosted
network passed: direct invite; recipient closed during text/image sends;
sender reload before receipt; recipient reconnect and decoded image catch-up;
both rows become Delivered; three-account group creation through a non-creator
invite; exactly one image rendered per account; group image and text show
Delivered. The final UI fixture passed picker selection/cancellation, whole-
window drops, explicit Send, size/multiple-file limits, stale reads, disabled
threads, overlay/listener cleanup and first-member status wording. The picker
now retains its hidden input until selection or cancellation rather than
detaching it immediately; this fixes the acceptance-run file chooser failure.
Its regression waits for the asynchronous preview rather than assuming a
fixed number of animation frames.

Focused audit remains clear against the updated Chat spec and commit-ack plan:
Chat owns receipt and group semantics, SDK owns generic byte/crypto behavior,
stores own persistence, and views own DOM/drop/picker presentation. Shared
receipt authorization and status application have one owner. No new split-
brain, boundary/SSOT, hidden-transform or god-class finding was introduced.
Dead/superseded status branches and duplicate status application were removed;
the obsolete immediate picker detachment was replaced. Existing large services
were not comprehensively decomposed or audited. Native packaging and the
remaining gated live-mesh suite were not certified by this browser release.

Acceptance evidence: `/tmp/rez-chat-release-20261111-eW3Ibo/`, including
`full-final.log`, `clean-live-group.log`, `final-focused.log`, `build-final.log`,
`public-verification.json`, the staged patch, package manifest, source revisions
and `browser-group-proof.jpg`. Initial diagnostics are retained separately.
No account data, mailbox state, node service, preview service or desktop/mobile
package was reset or redeployed. Existing tabs need a normal refresh; saved
legacy duplicate rows are retained, and Delivered means at least one member,
not every member or a read receipt.
