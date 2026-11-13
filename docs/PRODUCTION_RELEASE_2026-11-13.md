Status: Released and deployed for a small tester group.
Date: 2026-11-13.
Supersedes the private-only publication/deployment restriction in NATIVE_AUTH_PRIVATE_CANDIDATE_2026-11-13.md by explicit owner authorization. Its physical native-authentication evidence and stated limitations still apply.

# Rez rc.15 production tester release

Rez Chat 0.6.0-rc.15 is publicly available at https://github.com/rezprotocol/rez-chat/releases/tag/v0.6.0-rc.15 and is the desktop Latest/update channel. The same reviewed Chat runtime is live at https://chat.rezprotocol.io. Core, SDK and Node rc.15 are published on npm under `next`; all three `latest` tags remain `0.0.0-stage`. Their GitHub releases are marked prereleases. This is a qualified tester release, not a general availability or high availability claim.

## Provenance and files

No application, SDK, protocol, iPhone or Swift implementation was edited for this promotion. The exact previously qualified optimized, signed/notarized desktop artifacts from build 43447094939 were promoted. No rebuild changed those accepted bits. The freshly verified Node image/packages/CLI come from coordinated release run 43490217229. The browser was rebuilt from clean, frozen sources; 1,101 input files matched immutable references.

| Owner | Immutable runtime source |
|---|---|
| Core: protocol, crypto and shared signed vocabulary | `3d591dbf57183ac6fda1749f2cb8cd2d46c96814` |
| SDK: app facade, storage and client networking | `a2becf80cb935e736fcc9799fc2a0ed5e10cb630` |
| Node: hosted runtime, RPC validation and relays | `002e0505f99261333f02d1ffc0ff317918ac852a` |
| Chat: application and desktop OS host adapters | `c61874e9080b31b070f59e4046b667cccf4c23c8` |
| UI: reusable rendering framework | `d8375872621f05dc254e4861dff573b424e661a4` |

The existing candidate branch's later `5eb8020` commit adds tests/workflow selection and acceptance documentation; it does not change runtime source or locks. Release tags point at the actual artifact/package sources, not main. No main/master branch was merged or pushed. Original branches, HEADs, tracked diffs and untracked file hashes were checked against the pre-release preservation receipt.

Files added for release governance: this report and the cross-project `plans/RELEASE_FOCUS_2026-11-13.md` ruling. Operational outputs include the public asset/checksum manifest, signed updater manifest, immutable release archives and private verification receipts. On the host, only reviewed runtime/source/image selectors and public static assets were promoted; secrets and identity/data volumes were preserved. The old public hashed assets remain available for existing sessions. A temporary candidate HTML page was used for pre-promotion acceptance.

## Verification: PASS

- Required private desktop security/recovery preflight and signed installer jobs passed. Both Mac architectures are signed/notarized; Linux deb/AppImage startup checks passed. Mac installer/start/legacy-data upgrade and packaged-session checks passed. The Intel old-data fixture limitation is described below.
- The owner physically confirmed direct macOS Touch ID approval and cancellation with no preceding Rez warning. Cancellation remained locked; Rez-password fallback reconnected. This evidence is for the exact released runtime source, not a newly substituted build.
- The fresh coordinated Node release workflow passed its required PostgreSQL, Redis, mesh, packaging and isolated destructive recovery gates. Every container layer passed hygiene checks; the release scanner found zero HIGH/CRITICAL vulnerabilities and zero secrets at release time. This is a point-in-time result, not a future vulnerability guarantee.
- All three published npm tarballs matched verified CI bytes and SHA-512 registry integrity. A fresh external consumer installed only public registry packages, with no workspace symlinks, loaded the public APIs/CLI and completed two authenticated live connection/status cycles against the updated deployment.
- All four GitHub releases were read back anonymously. Tags, source targets, uploaded asset digests and counts match the verified local allowlists. The public Latest manifest and an anonymously downloaded Mac installer match byte for byte. Updater signatures and trusted comments verified for all four supported updater payloads; tampered payloads were rejected.
- All 19 production browser files match the frozen build hashes. The page and worker retain revalidation/no-store behavior. The public link preview works and rejects a foreign Origin.
- Browser acceptance passed once on the staged candidate and again on the public root: two accounts, responsive catch-up, interrupted image recovery, exact 700x700 image bytes, a single incoming image, Delivered, reply, and Delivered retained after sender refresh. No site data reset was needed.
- The live ten-minute two-node soak passed: 265 sent and acknowledged, 53 reconnects, both nodes visited, 26 tenant-isolation checks, worst observed round trip 707 ms. This sampled synthetic traffic and did not destructively interrupt production PostgreSQL or Redis. Post-soak readiness was healthy/non-degraded; all four updated runtime containers had zero restarts and low CPU/memory use.
- All three live relays completed TLS certificate verification and pinned peer authentication. Core/Node protocol source is unchanged from the previously deployed relay runtime, so relays were verified rather than restarted solely to change their version label.
- Actual Apple Silicon automatic update passed: an isolated copy of the published rc.10 app fetched the public Latest feed, installed rc.15 and restarted. Updated shell, Node and Info.plist bytes match the qualified signed app; bundled Node is 24.22.2. Strict deep codesign, notarization ticket and Gatekeeper checks passed. The synthetic saved account unlocked and became routable; prior text and image Delivered rows remained visible. Identity markers were unchanged. The isolated test app was stopped afterwards; personal profiles and the shared keychain key were not deleted.

## Deployment and recovery

The hosted nodes, portable backend and preview process run the same verified image ID `sha256:917739a22ed1c5938e9545e9fcc2faca8bc5cd42374c30e0f02407cfbfb6f71a`. Its archive SHA-256 is `8c707de90840ad54d759df9cf2d994de3c228922e39a6e627d05f02362cc056b`. PostgreSQL, Redis, TLS keys and persisted identities were retained. An operator-only logical backup, previous source/config selections, original web entry/worker and local rollback image tags were saved before activation. The backend rolled one service at a time with readiness gates; the web entry switched atomically after candidate acceptance.

For a normal code rollback, restore saved selectors and web entry/worker, leaving current user data intact. Do not restore the pre-release database over newly accepted messages. To withdraw the desktop offer, restore the previous GitHub release's Latest designation; preserve immutable rc.15 tags/assets. Neither a live data restore nor a live updater rollback was performed. Destructive recovery proof belongs to the isolated CI topology.

## Focused audit

Specs/contracts checked: AGENTS ownership and generic transport rules; CHAT_APP_SPEC hosted runtime, account custody, startup/catch-up, shared text/image pipeline and receipt semantics; existing native acceptance contract; desktop build/updater configuration; Node coordinated release/image hygiene gates; public preview bridge Origin contract; and plans README requirements for cross-project rulings. No protocol or message-commit semantics changed. The earlier MESSAGE_COMMIT_ACK_PLAN ownership remains untouched.

Canonical owners remain as listed above. Duplicate/split-brain findings: no duplicate runtime implementation or image send path was added; one qualified artifact set and one public updater manifest are used. Boundary/SSOT findings: no new application/Core import, per-directive transport facade, wire shape or alternate owner. God-class findings: none introduced; no runtime class changed. Dead code removed: none in this promotion; the redundant Rez authentication warning and duplicate image path were removed in the reviewed predecessor work. Tests added/updated in this promotion: none in product source; the existing browser acceptance test was copied to private scratch only to save a screenshot. Required release checks were run rather than bypassed.

Operational findings corrected before completion: the host has no standalone Node, so release helpers use the verified image; preview compose required explicit public image/source selectors; rollback error reporting was made explicit rather than suppressing failure. All final activation and verification gates passed. Initial preparation failures occurred before the affected activation and are retained in private logs. Private evidence is under `.local/production-release-20261113/`; no credentials, profiles, database backups or private signing material were attached to public releases.

## Remaining limits and follow-up

- This is a small tester release. Hosting still shares a single machine for the application nodes, PostgreSQL and Redis; two logical nodes do not establish infrastructure high availability.
- macOS 13.5+ Apple Silicon and Intel installers and Linux x64 packages are distributed. Windows users should use hosted web chat. A qualified Windows desktop installer was not produced. Native Linux device unlock is unsupported/fails closed; use a Rez password.
- The old Intel rc.10 distribution contained an ARM-only SQLite addon. Intel migration checks used old-format saved data with a compatible runtime, not a successful launch of that broken historical Intel artifact. The actual public-feed updater apply was exercised on Apple Silicon only.
- Physical older Macs, native OS-password fallback, updater rollback and additional native onboarding/group/recovery flows were not newly certified. Touch ID approval/cancellation and Rez-password fallback were certified.
- The pre-promotion browser tab was lost when the browser-control session closed during npm authentication. A same-tab update notice was not observed across this deployment. That unchanged service had prior live acceptance; this release adds fresh public-root and PWA/asset checks, not a new same-tab claim.
- Anonymous GHCR image access is not asserted. The scanned container archive is a public Node release asset and can be loaded directly.
- No full repository audit or indefinite production soak is claimed. The audit covers release operations, unchanged promoted artifacts and their direct contracts.

Feature development is now paused by owner direction. The next design work is librez: establish its consumer/API boundary, security and recovery invariants, platform/ABI needs and migration/compatibility proof before implementation. No language exception, new dependency or librez implementation is authorized merely by this release.
