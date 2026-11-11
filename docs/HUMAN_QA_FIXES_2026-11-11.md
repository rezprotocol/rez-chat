# Hosted chat QA fixes — 2026-11-11

**Status: PASS for the changed web flows.** Implementation `2256b82` is pushed
to `feat/hosted-cluster` and deployed at https://chat.rezprotocol.io. The published
desktop package remains on hold. No iPhone or Swift changes were included.

## Fixed behavior

- Self labels and message actions use the active account. Saving several
  accounts in one browser no longer makes every contact or group member “You.”
- The sidebar avatar follows the active identity and updates after saving or
  removing a photo. Superseded identity, profile and mount requests cannot
  repaint an older image.
- Archive, unarchive, lock and unlock return and emit the canonical thread
  summary, retaining its last message, activity and unread fields.
- Browser runtimes register the existing `links.unfurl` capability. Outgoing
  public URLs produce preview cards through a same-origin metadata service.
  Native clients retain the existing cached fetcher; both use the same parser
  and SSRF protection. Incoming URLs do not initiate automatic unfurls.
- Web System settings show the package version, the active uplink and an
  accurate distinction between peer counts and unavailable peer details.
- The tester guide recommends the hosted web client and records the desktop
  release hold. Only that correction was staged from the already-dirty guide.

## Files changed

| Area | Files |
|---|---|
| Active identity/profile | `src/ui/stores/SessionStore.js`, `src/ui/services/bus/SessionService.js`, `src/ui/views/SidebarNavView.js`, `src/ui/views/OwnAvatarView.js` |
| Thread summary | `src/server/services/ServerThreadsService.js` |
| Diagnostics | `src/ui/stores/ConnectionStore.js`, `src/ui/views/SettingsTabView.js` |
| Preview composition | `src/client/runtime/bootstrapBrowserChatRuntime.js`, `src/server/config/webPreview.js`, `src/server/services/RemoteLinksService.js`, `src/server/app/createWebPreviewServer.js`, `scripts/serve-web-previews.mjs` |
| Preview fetch/transport | `src/server/services/ServerLinksService.js`, `src/client/transport/HttpBridgeClient.js`, `src/server/transport/ChatHttpUplink.js`, `src/ui/views/MessageBubbleView.js` (privacy comment) |
| Deployment | `deploy/compose.web-previews.yml`, `deploy/nginx.web-previews.conf` |
| Regression tests | `test/stores/SessionStore.accessors.test.js`, `test/stores/Connection-Auth.accessors.test.js`, `test/thread.summary-and-send.contracts.test.js`, `test/profile.avatar-sync.test.js`, `test/server.links-ssrf.test.js`, `test/_helpers/fakeDom.js` |
| Specifications/report | `docs/CHAT_APP_SPEC.md`, `docs/TESTER_GUIDE.md`, this report |

The initial standalone QA test files were folded into the already-registered
profile and SSRF suites and removed. The normal test command runs the new cases;
no dependency, test-tooling, formatting or lint configuration changed.

## Verification

Clean candidate assembled from committed package sources, excluding unrelated
working changes. Final `npm test`: **1,118 passed, 0 failed, 3 gated integration
tests unrun**, followed by **2 portability tests passed**. This includes the new
regressions. Build and integrity injection passed. The final rebuild produced
the exact public entry hash shown below. `git diff --check` passed.

New coverage exercises active-account isolation and message ownership; avatar
save, identity change, stale completion and remount; complete state-change
summaries in responses and events; web version and count-only mesh diagnostics;
typed HTTP results, the browser fetch receiver, cancellation and response caps;
foreign origins, unsupported/account methods, body limits, private destinations,
DNS and redirect guards, spoofed forwarding headers, rate limits, concurrency
exhaustion and admission recovery. Existing DNS-pinning tests still pass.

Visible hosted browser checks used two synthetic accounts in separate tabs of
the same Chromium in-app browser and shared vault. They verified:

1. Normal unlock/connection with saved site data; correct names and incoming
   message controls; group roster shows Bob, Carol and only the active “You.”
2. Photo removal and re-save update the sidebar without refreshing.
3. Archive/unarchive and lock/unlock preserve the last-message snippet; lock
   disables sending and unlock restores two-way delivered text.
4. Example Domain and GitHub preview cards render for outgoing messages.
5. The promoted public client sends the existing 1,686,661-byte PNG fixture;
   the recipient renders it and the sender reaches **Delivered**. The image
   decodes at 700×700. This repeat fixture can reuse cached bytes; fresh-byte
   transfer/recovery proof remains in the preceding image-pipeline receipt.
6. The public System screen reports the web version, the active WSS uplink,
   seven peers and the absence of individual peer details consistently.

Screenshots and the bounded results are under the ignored local artifact
directory `artifacts/human-qa-fixes-2026-11-10/`. Test tabs were closed; saved
accounts were retained. Firefox, isolated browser profiles, separate physical
devices and packaged desktop clients were **not** rerun in this pass. The three
`RUN_INTEGRATION` desktop gates remain unrun; this report does not clear them.

## Deployment and live checks

- Source: `2256b82e719bccb8e98bc08aeb55e5d829b8588d`.
- Release: `/opt/rez/releases/web-ui-final-20261111/` on the existing hosted
  server. Public promotion: `2026-11-11T12:49:40Z`.
- Public script: `/assets/index-BZ2AiNEI.js`.
- Public entry SHA-256:
  `17fd725fabece4e245f37a411dce14754baa85d99302fdc9fcbc99c7dbad7f09`.
- The previous entry and immutable assets are retained for rollback. Promotion
  checked the previous entry for drift, swapped only `index.html` atomically
  and compared public bytes with the tested entry. Site storage was not cleared.
- One app-owned preview container was added on the existing host: read-only
  filesystem, non-root user, dropped capabilities, 256 MiB/0.5 CPU, bounded
  processes/logs, automatic restart and health checks, with no published port.
  No protocol-node images, OS packages, iPhone or Swift artifacts were changed.
- The tracked Chat nginx fragment was inserted in the hosted proxy configuration
  and syntax-checked. It strips cookies/authorization and disables access logs
  for metadata requests. The existing CSP is unchanged. Future proxy rollouts
  must preserve this app-owned fragment; the canonical route lives in Chat.
- Live foreign-origin, private-metadata-host and account-capability requests
  were rejected. The public entry hash and CSP matched; readiness reported
  `ok=true`, `degraded=false`, storage and Redis healthy.
- Six readiness and real preview samples passed from `12:51:48Z` through
  `12:52:39Z`; the final preview container remained healthy with zero restarts.
  This is a **51-second monitored watch**, not an overnight soak. A browser-tool
  stall left the first candidate backend running overnight while public HTML
  still selected the previous release; later health samples are not continuous
  monitoring of that interval. Proxy reload/container replacement produced
  brief preview-only errors before retry readiness passed and promotion occurred.

The preview endpoint uses the existing guarded fetcher with DNS pinning,
private-address rejection, redirect/byte limits and bounded DNS/fetch deadlines.
Its transport admits four concurrent requests, caps request bodies at 8 KiB,
limits each IP to 30 attempts/minute with bounded address tracking, and retains
the fetcher's global 100 attempts/five-minute budget. These metadata limits do
not change the attachment pipeline. The configured trusted proxy IP must track
the proxy container if its address changes.

## Focused audit

- **Specs checked:** `CHAT_APP_SPEC.md` §13; canonical `CHAT_BRIDGE_SPEC` and
  `CHAT_BRIDGE_METHOD_BINDINGS`; existing `BridgeRequest`, `BridgeResponse`,
  `LinksUnfurlParams`, `LinksUnfurlResult`, thread state/event records and the
  guarded fetcher's documented security invariants. The application spec was
  updated for the now-supported web behavior. No protocol spec changed.
- **Canonical owners confirmed:** Chat owns account presentation, thread
  semantics, link metadata and its app endpoint; ThreadStore owns thread state;
  ThreadIndex owns summaries; SessionStore owns self identity. SDK supplies
  existing bridge records; Node supplies its existing bounded limiter. Core,
  SDK and Node implementation sources were unchanged.
- **Duplicate/split-brain findings:** no second summary writer or preview parser
  introduced. Both preview topologies share `ServerLinksService`. The old
  all-saved-account self test and empty-summary state response were replaced.
- **Boundary/SSOT findings:** transports dispatch generically. Public capabilities
  derive from registered functions and canonical bindings; its isolated bus has
  no account, identity, message or node services. No per-directive runtime or
  desktop transport facade, new wire shape or cross-layer Core import added.
  The preview path is one app configuration constant. Architecture gates pass.
- **God-class findings:** no new mixed-responsibility class found. Composition,
  generic transports, app service, fetch/security and view rendering remain
  separate. Existing large services were changed only at their owning operation.
- **Dead code removed:** the loop treating all saved hints as self, the obsolete
  state-change decoration path, and superseded standalone test files. No legacy
  image path was reintroduced or changed.
- **WIP preservation:** original full dirty-diff hashes were reproduced after
  excluding only this task's changes. Core, SDK, Node and unrelated Chat changes
  match the saved baseline; the guide's pre-existing edits remain unstaged.
  No mobile/native source or generated artifact was staged or deployed.

## Remaining limits

This clears the reproduced web defects and changed-code audit, not a whole-app
security review or desktop release acceptance. Incoming-link unfurling remains
disabled. Outgoing preview URLs are visible to the hosted metadata service;
message bodies and account credentials are not sent there. The endpoint is
public metadata infrastructure: an Origin header is not authentication and
resource admission remains necessary. Its quotas can suppress optional previews
under load; chat sending and startup do not depend on it. Preview failures may
require a normal refresh to retry within the current renderer session.

The existing group status policy remains “Sent”; one member's receipt cannot
certify delivery to every group member. Destructive account actions, wallet
flows, device linking, recovery-phrase restore and a new native package were not
validated by this browser pass. Desktop custody/packaging gates still require
a separate accepted release.
