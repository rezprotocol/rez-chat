# Client acceptance — 2026-11-10

## Decision

**HOLD new tester invitations.** Subsequent real-user reports and a live
reproduction exposed an oversized durable-mailbox response that can prevent
web startup after image traffic (`mailbox.list timeout`). See
`rez-node/docs/NETWORK_MAILBOX_RECOVERY_2026-11-10.md` for the repair and recovery
evidence. Image sender delivery receipts are also incomplete. The original
new-account text checks below passed, but did not establish readiness for
existing media-bearing accounts. The copyable instructions below are held
pending that work. **HOLD the published desktop app.** Both clients were
exercised against the network deployment described in `rez-node/docs/NETWORK_DEPLOYMENT_2026-11-10.md`.
The initial check did not redeploy that candidate; the later mailbox incident
required the server repair linked above.

The published desktop app connects to all three updated public relays, but its
chat-session startup fails. The source fix below is committed but unpublished. The download also predates the existing local root-key custody
fix. Do not direct testers to the current desktop release.

## Observed client results

| Check | Result |
| --- | --- |
| Actual `https://chat.rezprotocol.io` assets in two isolated Chromium contexts | PASS |
| Two new browser accounts and 24-word recovery screens | PASS |
| Generate/accept invite and establish the contact relationship | PASS |
| Close recipient tab, send message, reopen and password-unlock the same browser profile | PASS: exact received plaintext rendered |
| Reply from the reopened recipient to the original sender | PASS: exact reply rendered |
| PWA manifest and service-worker readiness | PASS; installed-PWA lifecycle not tested |
| Official macOS ARM desktop `v0.6.0-rc.10` signature and notarization | PASS |
| Released desktop connections to r1, r2 and r3 | PASS |
| Released desktop create-account and password unlock in an isolated profile | PASS |
| Released desktop chat startup, on first login and restart | FAIL: startup error and Offline status |
| Desktop/web messaging interoperability | NOT PROVEN: desktop cannot reach working chat UI |
| Intel Mac, Linux, Windows, Safari and Firefox clients | NOT CHECKED |
| iPhone / Swift / physical mobile acceptance | OUT OF SCOPE; untouched |

## Desktop diagnosis and repair

The local authenticated control channel returned `DESKTOP_IPC_ERROR` from
`desktop:runtime:connect`:

> RezClient.identity requires an account-mode client

`DesktopSupervisor.connect()` builds its runtime summary through
`ServerSessionService.getSessionInfo()`. That service read the account-only
`sdk.identity` capability even when the desktop's normal data-plane SDK client
authenticates as a claimant. The error occurs after the chat server starts and
is caught by the IPC response wrapper, leaving the UI offline. No protocol
downgrade or network-server workaround is appropriate.

The service now reads device metadata through the SDK's existing public
`getIdentity()` method. That method supports both authentication modes. The
existing local `server` label is retained when a claimant session has no device
identity. Vault account/device ownership and the generic IPC dispatcher remain
unchanged; no account connection is opened to render status.

The regression runs the actual session service through the desktop supervisor
with an account-capability getter that throws. It covers claimant and account
metadata. Both cases failed before the fix and pass afterwards.

## Files changed in this acceptance work

- `src/server/services/ServerSessionService.js`: remove the account-only
  capability read from status construction.
- `test/desktop.supervisor.test.js`: two startup regression cases using the
  real session service.
- `test/e2e.hosted-web.test.js`: require a reverse-direction live message after
  offline recovery.
- `docs/CLIENT_ACCEPTANCE_2026-11-10.md`: this receipt and tester instructions.

No existing iPhone, Swift, SDK, Core, Node or native launcher source was edited.
The previously dirty Chat files are preserved: the binary diff excluding the
three implementation/test paths above still hashes to
`495890ca3878a4cb52434a963d5ff75b54d158e1b8ae344477a360e401e283b9`.

## Verification

- Focused desktop supervisor, bus bridge, runtime client, generic IPC and
  Chat-to-Core boundary suites: **29 pass, 0 fail, 0 skipped**.
- Existing F8 authentication-boundary integration suite, including a real local
  node and full claimant-mode desktop chat bootstrap: **9 pass, 0 fail,
  0 skipped**.
- An isolated in-memory instrumentation of that same suite additionally calls
  the fixed session service against the real connected SDK and checks its
  account, device label and inbox metadata. **9 pass, 0 fail, 0 skipped**;
  these overlap the preceding nine and are not additional unique tests.
  The existing integration test file was not changed. An initial version of
  this temporary harness failed to resolve a dynamic import; after correcting
  harness resolution, the complete run passed.
- Final live hosted-web acceptance, including the new reverse reply:
  **1 pass, 0 fail, 0 skipped**, 27.4 seconds. A preceding one-direction run
  also passed; counts overlap.
- `git diff --check`: PASS.
- Official desktop archive SHA-256:
  `a08283507a6ccc07ae98b887fc2f726759309446c14d20e2c1f5659d8ff6d14b`.
  Deep strict signature verification and Gatekeeper assessment both passed.

Local evidence is in `/tmp/rez-client-acceptance-20261110/`:
`desktop-regression-before.log`, `desktop-regression-after.log`,
`claimant-integration.log`, `desktop-real-session.log`,
`desktop-diagnostic.log`, `web-live-final.log`, `codesign.log` and
`gatekeeper.log`. The native test used only an isolated temporary profile;
the test app was stopped afterwards. The signed app was not modified.
Test-account recovery material must not be copied into a release or report.

## Focused audit

- **Specs checked:** `docs/CHAT_APP_SPEC.md` sections 1–5;
  `plans/F8_REZCHAT_ROLE_SPLIT_PLAN.md` claimant/account separation and
  no-proactive-account-session invariant; SDK `RezClient.getIdentity()` and
  account-gated `identity`; Node `SessionCapabilities` metadata semantics;
  `plans/SECURITY_LOCAL_SECRET_CUSTODY.md` for the separate release blocker.
- **Canonical owners confirmed:** Chat owns application session presentation
  and desktop lifecycle; SDK owns network/session identity access; Node owns
  node RPC records; Core owns shared protocol and cryptography. No ownership
  was moved.
- **Duplicate / split-brain findings:** removed the status path's inappropriate
  account-capability lookup; reused the existing SDK accessor. No new identity
  store, account channel or dispatch table was introduced.
- **Boundary / SSOT findings:** no new cross-layer import, wire payload shape,
  per-directive transport method or duplicated protocol validation. Generic
  IPC and Core-import boundary checks pass. No unresolved finding in the
  touched code and direct dependencies.
- **God-class findings:** none introduced; the change stays within the existing
  session metadata method.
- **Dead code removed:** the superseded account-only accessor expression. No
  unrelated cleanup.
- **Tests updated:** the desktop startup regression and live web reply above.
- **Scope:** focused audit only; no whole-product security re-audit, whole-repo
  test run, new native build, update-delivery check or fresh 30-minute soak.

## Release limitations and follow-up

The desktop fix has not been packaged, signed, notarized, published or tested
as a new native artifact. The currently published `v0.6.0-rc.10` therefore
remains a failed acceptance target. Its local root-key exposure is separately
documented in the custody plan; source-only fixes do not protect that download.

A corrected desktop candidate must include the pending custody maintenance
work, satisfy the release gates, and pass native desktop plus desktop/web
messaging acceptance. The earlier maintenance receipt at
`artifacts/project-status-2026-10-07/maintenance-release.html` records dependency
and native-launcher policy blockers; those gates were not changed, bypassed or
revalidated in this client check. No native or Swift changes were attempted.

The browser result is scoped to basic direct messaging with new test accounts
on Chrome. Groups, files, device linking, account recovery from the phrase,
multi-device history and other browser engines are not certified here. Keep
the first pilot small and use test content. Browser-local history is not
reconstructed merely by retaining a recovery phrase.

## Copyable instructions for the first testers

Please help test Rez Chat. For this round, use Chrome on a computer and open
https://chat.rezprotocol.io — no download needed. Please skip the desktop and
phone apps for now.

1. Create a new test account. Save your password and 24 recovery words privately;
   never send either to anyone.
2. Open **Contacts**, generate an invite code and share it privately with one
   other tester. They can paste it into their invite box and accept it.
3. Open your conversation and send a few messages both ways.
4. Have one person close their Rez tab. Send them a message, then have them
   reopen the same site in the same browser profile and unlock. Check that the
   message arrives and that they can reply.
5. Send me what worked or failed, your operating system/browser, the approximate
   time, and a screenshot of any error with private details hidden.

Use ordinary browser windows, keep the site's saved data, and use test content
only. This is an early test; don't depend on it for important conversations.

## Subsequent media regression and repair

The server byte-budget repair is live; see the linked Node report for audit,
deployment and recovery evidence. The permanent hosted-web test now also sends
a valid PNG larger than one frame while the recipient is offline, verifies
exact recovered bytes and actual 700×700 rendering, and requires a reply. The
complete Chrome workflow passed in 62.1 seconds. A separate Firefox test also
passed with a 1.7 MB PNG. Source and deployed assets remain distinct: these
checks exercised the existing public web assets against the new server.

Focused test audit: the synthetic image is encoded by the browser; receipt
checks compare exact bytes and real decoded dimensions. It uses only isolated
test accounts and UI flows, adds no dependency/wire shape, and does not claim
that the still-missing image delivery receipt is fixed. No new ownership,
SSOT, duplicate logic, boundary, god-class or dead-code finding in this test
and its direct UI/service dependencies. Existing iPhone/Swift/Chat work retains
its original binary diff hash recorded above. New tester invitations remain
held for the open latency, media-status and desktop-release issues.

## Background startup and interrupted-image acceptance

The subsequent network lookup and ACK fixes are deployed. See Node
`NETWORK_LOOKUP_LATENCY_2026-11-10.md` and SDK
`HANDSHAKE_ACK_RECOVERY_2026-11-10.md` for the source, timings and honest
passing/failed soak record. The old client's already-lost partial image bytes
cannot be recreated by ACK replay; affected images may need a sender resend.

The new web-background candidate separates local startup from initial catch-up
and durably persists image chunks/context before application acknowledgement.
The permanent hosted-web regression deliberately holds later mailbox pages
after at least one chunk commits locally and its consumed cursor is confirmed
by the server. While the image is still incomplete, the UI becomes usable and
sends a message to the other account. Closing/reopening the page with the same
saved site data then recovers the exact PNG and 700×700 decoded dimensions;
the consumed first page is not redelivered. A reverse reply also succeeds.

This complete workflow passed in **Chrome (41.9 s)** and **Firefox (40.1 s)**,
zero failures/skips. Unlock-to-usable measured **1.832 s in Chrome / 1.856 s
in Firefox** with later image pages blocked. These are synthetic acceptance
observations, not a guaranteed startup time. Tests retain browser storage.

Clean-source full suites: Core **582 pass**, SDK **549 pass**, Chat **1,118
pass / zero fail / three gated native/live integrations not run**, isolated
SDK portability **2 pass**, extra background/order cases **5 pass**. The
production web build/integrity injection passes. Full changed-file/spec/
ownership/SSOT audit, removed paths and remaining risks are recorded in SDK
`docs/CLIENT_SYNC_RECOVERY_2026-11-10.md`.

Files changed in this slice: `ChatServerApp.js`, `InboxCatchupService.js`,
`ServerFileTransferService.js`, `ConnectionService.js`; file-transfer,
background-startup, sync-order and hosted-web tests; section 13 of
`CHAT_APP_SPEC.md`; and this receipt. Unrelated tracked Chat changes still
hash to the original `495890ca3878a4cb52434a963d5ff75b54d158e1b8ae344477a360e401e283b9`.
iPhone/Swift work remains untouched.

The tested background web build is publicly live as of **23:51:23 UTC**,
entry script `assets/index-BYcczCDv.js`, entry SHA-256
`d8a175580df0635cdbf8f04903dbfdc1a72de4cd00d8972f2b9f16d661394c89`.
Post-promotion public Firefox login/invite/text/offline-reopen/reply passes
in **12.3 s**; existing-contact unlock **1.759 s**, first-message receive
**342 ms**. Server readiness is healthy and the public entry matches the
verified artifact. Normal refresh is sufficient; retain all saved site data.

This does not implement true on-demand media fetching, worker-based
reassembly, sender image delivery receipts or a new desktop package. Keep
the published native release on hold. The earlier “Firefox not checked” row
describes the initial acceptance only; Firefox web recovery is now checked
as described here. New invitations remain held for the open client/release
limitations, rather than treating “online” as proof of complete history.
