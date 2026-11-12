# Private desktop candidate: 2026-11-12

This is a qualification candidate, **not an approved public desktop release**.
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
  dependencies are updated. No direct dependency or vendored code is added.
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
  builds, macOS signing/notarization verification and real installed-app smoke
  tests. macOS also upgrades a checksum-pinned rc.10 profile using each bundle's
  actual vault/storage/SQLite code. Only CMS AES-256-GCM ciphertext is uploaded;
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
| Database-backed complete local mesh | Final run pending at initial source checkpoint; see final qualification receipt |
| Signed/notarized macOS and Linux installers | Pending private CI; unsigned local output is not a substitute |

An initial local backed mesh run collided with the Electron test's temporary
SQLite ABI rebuild. The isolated failing case passed after restoring the Node
binding. The complete backed gate is rerun serially; no product code or readiness
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

**Tests added/updated:** custody failure/legacy upgrade cases, durable ACK retry
cases, runtime ownership admission/retry cases, two native launcher tests,
packaged verifier symlink regression, synthetic restart fixture ownership,
real two-window UI gate and reusable artifact upgrade checker. Existing mesh
and backend recovery assertions remain in force.

**Remaining acceptance:** private CI signing/notarization, actual Intel/Linux
installer results and OS-keychain/biometric interaction; physical older-Mac
coverage and owner visual acceptance. No iPhone/Swift/Windows acceptance is
claimed. No public distribution is approved by these checks.
