# Private desktop candidate: 2026-11-12

**Automated qualification: PASS on Apple Silicon, Intel Mac and Linux.**
This is a private qualification candidate, **not an approved public desktop release**.
No npm publication, release tag, GitHub Release, updater-feed promotion, container
push or hosted deployment is part of this work. The private application version
is `0.6.0-rc.15`; Core, SDK and Node use the same private coordinated version.

## Changes and ownership

- **Chat account custody:** `src/server/identity/ChatServerIdentity.js` requires
  the unlocked vault identity, reads stored identity strictly and preserves
  corrupt/mismatched recovery evidence. It removes the fallback account-generation
  path. Existing inline root keys are scrubbed only after matching the unlocked
  vault; encrypted data, account ID and device ID remain readable across restart.
  `src/server/bootstrap/bootstrapChatServer.js` removes the obsolete crypto
  argument. `src/index.js` and `StoredServerIdentity.js` correct stale comments.
- **Chat durable acknowledgement:** `ServerEventService.js` propagates failed
  control acknowledgements so normal pending-work recovery can retry them.
- **SDK delivery ownership:** `PeerLinkService.js` validates the complete runtime
  grant, releases rejected grants and permits admission/recovery to retry after
  the prior owner releases. No delivery ownership moves into the desktop shell.
- **Native launcher:** only the two existing `src-tauri/src/{sidecar,lib}.rs`
  files change under the owner's explicit desktop-only Rust exception. Packaged
  builds require the adjacent bundled Node and bundled JavaScript resources;
  developer overrides and PATH fallback remain debug-only. The key-holding child
  gets a small OS/session environment allowlist, excluding Node loader hooks,
  dynamic-library injection, proxies and developer path overrides.
- **Release inputs:** `.node-version` pins Node 24.22.2. The fetcher verifies its
  official archive checksum every time rather than trusting an existing binary.
  `rust-toolchain.toml`, Cargo manifests/lock and the existing JavaScript build
  dependencies are updated. No direct dependency or vendored code is added. The same Tauri CLI 2.11.2 is fetched from its official, SHA-256-pinned release binary instead of recompiling the builder.
  Tauri resource sources and native-module rebuilds use the root workspace.
  `release/workspace-package{,-lock}.json` reproduce that single install.
- **Support floor:** this candidate requires **macOS 13.5+**, matching its bundled
  Node 24 runtime. This does not prove compatibility on every older supported
  macOS release. Windows remains deferred pending approved signing credentials.
- **Qualification:** `verify-packaged-desktop.mjs` uses an isolated free port and
  canonical executable path. The desktop UI gate targets the application rather
  than the splash screen, acknowledges recovery onboarding without recording its
  words, expects the current v3 invitation format, and fails when explicitly
  requested prerequisites are missing. The actual Electron development shell UI
  check is distinct from tests of the shipped Tauri installer.
- **Private build workflow:** manual-only, immutable sibling revisions, read-only
  repository permissions, security/recovery gates before builds, platform-native
  builds selected from `release/desktop-build-inputs.json`, macOS signing/notarization verification and real installed-app smoke
  tests. macOS also checks a checksum-pinned rc.10 encrypted-data upgrade: ARM
  uses the original executable; Intel uses the explicit legacy-format fixture
  described below because the old published Intel SQLite binary is broken. Only CMS AES-256-GCM ciphertext is uploaded;
  its RSA-OAEP recipient private key stays on the operator's machine. There is no
  release-creation or updater-publishing step. Ciphertext expires after three days.

The original five checkouts, active branches, staged state and unrelated work
are preserved. Candidate source is saved on separate local
`candidate/desktop-rc15-20261112` branches using isolated Git indexes. The build
workspace starts from committed sources, with individually reviewed desktop
maintenance changes. Existing iPhone, Swift, storage-provider migration and
branding-deletion work is excluded. No iPhone or Swift source is modified.

## Local verification

Evidence is kept privately at `/tmp/rez-desktop-private-20261112/`:

| Check | Result |
| --- | --- |
| Full JavaScript dependency audit | PASS: zero advisories, all severities |
| RustSec scan | PASS: zero vulnerabilities and zero unsound warnings; seven informational unmaintained entries remain |
| Core / SDK / UI suites | PASS: 582 / 550 / 12 tests |
| Node suite with actual PostgreSQL + Redis | PASS: 1,413 tests, no skips |
| Standard Chat suite | PASS: 1,135 passing, three opt-in desktop cases checked separately; two additional portability tests pass |
| Focused custody, real password-vault upgrade and sidecar cases | PASS: 47 tests |
| Native launcher environment/path security | PASS: two Rust tests |
| Enabled multi-client event + mutation integration | PASS: two tests, no skips |
| Enabled real Electron UI, two windows | PASS: signup, invite, acceptance and bidirectional messages, no skips |
| TLS two-node destructive recovery | PASS: all five tests, including both-node SIGKILL, Redis loss, PostgreSQL blackhole and backup restore |
| Tauri ARM macOS app + DMG | PASS: local unsigned intermediate built |
| Actual DMG installation into isolated folder | PASS: two fresh-profile launches, sidecar health and process reaping, no PATH Node |
| Installed release with hostile Node options / developer paths | PASS: two boots, injection marker never written |
| Published rc.10 to candidate artifact upgrade | PASS: real old vault/SQLite/encrypted message; wrong-password evidence preserved; same network/account device identities; root key scrub; two runtime boots and two installed-shell launches |
| Final packaged-verifier and boundary checks | PASS: eight tests, no skips |
| Database-backed complete local mesh | PASS: 16 tests, zero failures and zero skips |
| Signed/notarized macOS and Linux installers | PASS: Apple Silicon and Intel DMG install/start/signature/ticket gates; Linux deb and AppImage each start twice |
| Intel encrypted-data upgrade and packaged session | PASS: legacy-format fixture, two installed launches, two real sidecar unlock/RPC/history/lock cycles and clean exit |

An initial local backed mesh run collided with the Electron test's temporary
SQLite ABI rebuild. The isolated failing case passed after restoring the Node
binding. The complete backed gate then passed serially; no product code or readiness
assertion was weakened to hide that test-environment error. The private workflow
runs these stages serially too.

## Required focused audit

**Specs checked:** repository AGENTS ownership/transport/record rules;
`docs/CHAT_APP_SPEC.md` runtime responsibilities and desktop custody;
`docs/SECURITY_AUDIT.md` hardened-runtime constraints; existing GHSA-7gc9 custody
record and tests; `src/desktop/sidecar/HostChannel.js` launch/lifetime contract;
`ChatBridge.js` generic bus specification; SDK runtime ownership contracts;
Node durable-inbox/hosted recovery tests; pinned upstream Node platform floor.

**Canonical owners confirmed:** Core protocol/crypto remains unchanged apart
from private version metadata; Node retains runtime/RPC validation and storage
mechanics; SDK owns client/delivery admission; Chat owns vault/session and chat
acknowledgement behavior; UI remains framework-only. Native launcher changes
only select trusted resources and supervise the child.

**Duplicate/split-brain:** removed fallback identity generation, stale cached
sidecar trust and packaged developer executable/source selection. Vault is the
sole root-key source. Node runtime version is owned by `.node-version`; sibling
source revisions are owned by the workflow's four immutable refs.

**Boundary/SSOT:** no new Core imports in application code, no SDK-to-Node source
coupling, no protocol logic in UI/native shell, no per-directive desktop facade,
no new wire records or hidden serialization layer. Architecture tests pass.

**God-class/mixed-responsibility:** no new production class or service;
`ServerEventService` remains an existing large service, with a narrow error-flow
change only. This is a focused audit of touched code and direct dependencies,
not a whole-repository architecture certification.

**Dead/stale code removed:** random account-generation fallback, unused identity
crypto argument/imports, release-mode developer source/Node overrides, release
PATH fallback, old sidecar cache fast path, tag-triggered publishing in the
candidate workflow, unconfigured Windows jobs and stale UI-test assumptions.

**Tests added/updated:** reusable packaged-session unlock/RPC/history/lock checker,
custody failure/legacy upgrade cases, durable ACK retry
cases, runtime ownership admission/retry cases, two native launcher tests,
packaged verifier symlink regression, synthetic restart fixture ownership,
real two-window UI gate and reusable artifact upgrade checker. Existing mesh
and backend recovery assertions remain in force.

**Remaining acceptance:** OS-keychain/biometric interaction, physical older-Mac
coverage and full native WebKit visual/user-flow acceptance. Automatic
updater application/rollback against a release feed was not performed. No iPhone/Swift/Windows acceptance is
claimed. No public distribution is approved by these checks.

## Private platform qualification

Runtime source/dependency cut: `5c4c47048dbc3a428b4c7ecf247cec9401ca187f`.
[Private CI 43315856191](https://github.com/rezprotocol/rez-chat/actions/runs/43315856191)
passed all shared gates. Apple Silicon and Linux installers completed their
platform gates and encrypted uploads. Downloads were authenticated-decrypted
locally and matched both archive checksums and the exact source commit.

The signed Apple Silicon DMG additionally passed local strict/deep code-signature
verification, Gatekeeper, ticket validation, two fresh launches, two launches
over a migrated rc.10 profile, and two hostile-environment launches without
executing the injection marker. The artifact's actual sidecar then completed
two password-unlock, real node-status RPC, encrypted-history read and lock cycles
in the SAME process, with a required clean exit. This is reproducible with
`scripts/verify-packaged-session.mjs`; host keychain/biometric availability is
explicitly unavailable in that synthetic password-vault test. Native UI
automation is not enabled on the local Mac; no physical-keychain, biometric or
full native WebKit visual-interaction acceptance is claimed. The actual two-user
renderer flow was exercised in the Electron development shell, separately.

Intel's new signed installer passed its two fresh starts. One ticket validation
failed after Apple accepted notarization because Apple's CloudKit connection
was lost (NSURLError -1005); only the failed platform was rerun. Bounded strict
ticket-check retries address that external transient without bypassing ticket
verification. Future builds disable target-directory caching; task-owned native
build caches were deleted after qualification. Only registry/tool caches remain.

The next Intel attempt exposed a defect in the OLD published rc.10 Intel asset:
its SQLite addon is ARM-only and cannot load in its x86 Node runtime. Its pinned
archive SHA-256 matches the official release, so this is an existing packaging
defect. The candidate builds on native Intel runners and already passed its
actual SQLite/vault startup checks. There is no claim that the broken old Intel
executable successfully created a profile. Instead, the explicitly named Intel
FORMAT fixture uses the verified old JS/schema/crypto tree with only the SQLite
package and its loader dependencies replaced by the candidate's compatible
signed package, under the candidate Node runtime. That fixture method was
verified locally and passed on the native Intel runner. Apple Silicon's upgrade
fixture uses the unmodified old published artifact and its actual old Node/SQLite
runtime.

[Intel CI 43330019109](https://github.com/rezprotocol/rez-chat/actions/runs/43330019109)
completed successfully at source `893b2b2c84e4f0948709bd223a88b4d905aadce4`,
including shared security/recovery preflight, both native launcher tests, signed
and notarized build, DMG install and two starts, legacy-format upgrade, two real
packaged-session cycles, clean exit and encrypted upload. Local authenticated
decryption, archive/source verification and individual installer checksums pass.
The downloaded Intel executable, Node and SQLite addon are all x86_64, and its
installed bundle passes strict/deep code-signature verification locally.

Runtime source and dependency locks are identical between the ARM/Linux source
cut and Intel source cut. Only the qualification workflow, input manifest, session
checker and this report differ. The final bookkeeping commit changes only this
report and disables native target caching; no rebuild is required for those edits.

Private recovered installers and SHA-256 inventory are retained outside Git under
`.local/desktop-candidates/rc15-20261112/installers/`. Encryption keys are kept
separately. A filename scan of installed resources found no environment files,
npm credentials, PEM/private-key/certificate files or SQLite database dumps;
this was a targeted package-content check, not an entropy-based secret audit.

The owner explicitly authorized the five candidate source branches and encrypted
private signing runs. Public releases, npm writes, updater promotion and hosted
deployments remain unauthorized and unchanged by this work. All five original
HEADs, tracked diffs and untracked-file contents match their initial snapshots.

Upstream references: [Node v24.22.2 platform requirements](https://github.com/nodejs/node/blob/v24.22.2/BUILDING.md),
[official Tauri CLI 2.11.2 release](https://github.com/tauri-apps/tauri/releases/tag/tauri-cli-v2.11.2).
The refreshed Tauri ACL/schemas add exit/fullscreen command descriptions and
notification-listener removal; only listener removal enters notification
defaults. App capability configuration is unchanged; no filesystem, network,
loader or shell-execution permission is introduced. Historical comments refer
to `HOSTED_NODE_DESIGN.md`, which is absent from this checkout and was not
checked; current `CHAT_APP_SPEC.md` and the listed executable contracts were
checked instead. Those stale comment links remain a documentation follow-up.

### Files changed

**rez-core**

- `package.json`

**rez-sdk**

- `package.json`
- `src/peer-link/PeerLinkService.js`
- `test/peer-link.runtime-ownership.audit.test.js`

**rez-node**

- `package.json`
- `release/workspace-package-lock.json`

**rez-ui**

- `package.json`

**rez-chat**

- `.github/workflows/desktop-build.yml`
- `package.json`
- `rust-toolchain.toml`
- `scripts/desktop-native-modules.mjs`
- `scripts/fetch-sidecar-node.mjs`
- `scripts/verify-packaged-desktop.mjs`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/gen/schemas/acl-manifests.json`
- `src-tauri/gen/schemas/desktop-schema.json`
- `src-tauri/gen/schemas/macOS-schema.json`
- `src-tauri/src/lib.rs`
- `src-tauri/src/sidecar.rs`
- `src-tauri/tauri.conf.json`
- `src/index.js`
- `src/records/domain/StoredServerIdentity.js`
- `src/server/bootstrap/bootstrapChatServer.js`
- `src/server/identity/ChatServerIdentity.js`
- `src/server/services/ServerEventService.js`
- `test/chat-server.identity.bip39.test.js`
- `test/desktop.packaged-smoke.test.js`
- `test/desktop.two-user-ui.integration.test.js`
- `test/e2e.internet.catchup.test.js`
- `test/e2e.internet.chat.test.js`
- `test/e2e.internet.group-offline-accept.test.js`
- `test/e2e.internet.group-three.test.js`
- `test/e2e.internet.group.test.js`
- `test/e2e.internet.queued.test.js`
- `test/e2e.internet.recovery.test.js`
- `test/e2e.local-mesh.chat.test.js`
- `test/e2e.local-mesh.delegated-invite.test.js`
- `test/e2e.local-mesh.group-coremember-separation.test.js`
- `test/e2e.local-mesh.group-offline-accept.test.js`
- `test/e2e.local-mesh.group-reconnect.test.js`
- `test/e2e.local-mesh.group-recovery.test.js`
- `test/e2e.local-mesh.group-three.test.js`
- `test/e2e.local-mesh.group.test.js`
- `test/e2e.local-mesh.reconnect-asymmetric.test.js`
- `test/server.claimant-mode.f8.test.js`
- `test/server.message-commit-ack.test.js`
- `.node-version`
- `test/support/bootstrapTestChatServer.js`
- `scripts/verify-desktop-upgrade.mjs`
- `release/workspace-package.json`
- `release/workspace-package-lock.json`
- `docs/DESKTOP_PRIVATE_CANDIDATE_2026-11-12.md`
- `scripts/verify-packaged-session.mjs`
- `release/desktop-build-inputs.json`
