# Rez Chat native mobile build

Current status: iOS development implementation, with real native enrollment,
encrypted text and attachment delivery, verified text receipts and restart
acceptance. Android is deferred at the user's direction. This is not yet a
signed, release-ready iPhone distribution.

The application and protocol execute as JavaScript in an independent native
engine. The WebView renders the existing Rez Chat UI and exchanges generic
records with that engine. Swift implements OS storage, cryptographic primitives,
WebSockets and lifecycle mechanics. No chat directives live in native code.

Account creation, unlock, recovery, profile naming and device linking use the
same `AccountRegistry`, `AuthBootstrapService`, `AccountAuthService`,
`SessionStore` and `DeviceLinkRunner` as the web application. Native storage is
a provider for those shared objects. `MobileApplicationHost` only binds typed
host operations to them. An older single-row mobile vault is read once for an
in-place migration, verified in canonical storage and then deleted; it is not an
active account implementation.

## Build the iOS simulator app

Use the repository root's existing dependencies; never install packages inside
this directory. The local build was verified with Node 25.7, Xcode 26.5,
xcodegen and the installed Tauri/Rust iOS toolchain.

1. Create a deployment JSON using `deployment.example.json` as the schema.
   Its `.example.invalid` URLs deliberately do not connect to a real service.
   Enrollment addresses belong to the Pg account home; portable addresses
   belong to the separate filesystem claimant provider. Both must use WSS.
   The activated Rez deployment is already configured in `deployment.hosted.json`.
2. From `rez-chat`, run:

   ```sh
   node scripts/mobile-build.mjs /absolute/path/to/deployment.json
   ```

3. On a fresh generated project, from `rez-chat/mobile`, run `cargo tauri ios init`.
   Then, from `rez-chat`, run:

   ```sh
   node scripts/mobile-prepare-ios.mjs
   ```

   This applies the simulator-only Keychain entitlement embedding reproducibly.
   Device signing must use the actual Apple development team and entitlements.
4. From `rez-chat/mobile`, run:

   ```sh
   cargo tauri ios build --debug --target aarch64-sim --no-sign --ci
   ```

   The generated app is under `src-tauri/gen/apple/build/arm64-sim/Rez Chat.app`.
   Tauri can fail when its final output directory already exists; remove only
   that generated app directory before rebuilding. Generated Xcode and Rust
   outputs are ignored; the launcher, Swift packages and preparation script are
   the source of truth.

The application identifier is provisionally `io.rezprotocol.chat.mobile`.
Production identifiers, signing, App Group configuration and push credentials
are not configured by the offline example.

## Verify

From `rez-chat`:

```sh
node --test test/mobile.host-contracts.test.js test/mobile.core-boundary.test.js
node scripts/mobile-verify-native.mjs
```

The native verifier compiles Swift and runs independent JavaScriptCore processes,
not mocked WebViews. It checks cryptographic interoperability, encrypted storage,
corruption rejection, process exclusion, killed-owner recovery, fencing,
recoverable vault custody, two-way text messages, commit acknowledgements and
restart persistence against isolated real nodes.

Live hosted acceptance (creates synthetic test accounts and sends messages/files
through the configured deployment):

```sh
node scripts/mobile-verify-hosted.mjs mobile/deployment.hosted.json --delegated
```

An earlier build passed on 2026-09-08 using public TLS: account creation, invite acceptance,
offline text delivery, same-inbox restart, verified receipt, reverse attachment,
account-home approval and linked-phone catch-up after restart. Actual Simulator
UI acceptance also passed create/unlock, invite acceptance, sending a delivered
message, receiving a reply and retaining both after restart. Unlock now drives
the canonical foreground recovery pass even when the OS wake arrived while locked.
The later shared-auth convergence change was verified with the complete local
two-account mesh flow and native process suite. Its live hosted rerun remains a
separate mutation-authorized gate because that probe creates persistent
synthetic accounts on the deployment.

Photos and documents use the existing composer (up to 10 MiB). On iPhone,
their Save/Share action opens the iOS share sheet, including Save to Files.
Attachment routing uses the same verified device roster as text, so a linked
phone receives its own encrypted copy. Temporary shared files use complete OS
file protection and are removed when sharing completes or is canceled; any
interrupted export is removed before the next share.

The enrollment acceptance additionally needs an isolated PostgreSQL test
database, supplied through `REZ_PG_TEST_URL`:

```sh
node scripts/mobile-verify-native.mjs --delegated
```

That mode creates and removes a dedicated schema. It exercises actual primary
approval, native enrollment, portable activation, new-contact synchronization,
immediate first-message delivery and a claimant restart after stopping the
enrollment home. It fails when the database setting is absent; it does not skip
that gate. Never point the verifier at a production database.

The public fixed storage key appears only in `apple/probe/main.swift`, the test
executable. The app obtains its storage key from Keychain. Application records
stay in encrypted SQLite; native storage does not interpret them.

## Remaining acceptance

- Opaque push-route registration, APNs transport and OS delivery integration.
- Cold background unlock, OS scheduling, App Group/NSE and process-budget gates.
- Backup/history migration, QR and physical-device keyboard/attachment/UI acceptance.
- Full account-management parity for device unlock and platform backup flows.
- Durable terminal failure notice/replay, the separate existing delivery gate.
- Physical-device interruption/48-hour acceptance, signing and beta distribution.

Android engine, launcher, SDK setup and FCM are deferred and do not block the
current iOS feature work.

See the root `plans/MOBILE_IMPLEMENTATION_2026-09-08.md` execution ledger and
`plans/MOBILE_IMPLEMENTATION_AUDIT_2026-09-08.md` for checked ownership, findings,
verification evidence and outstanding work. The live mobile provider and edge
were activated with user authorization; see `plans/MOBILE_HOSTED_ACTIVATION_2026-09-08.md`
at the repository root. No commit, push, store submission or app release was performed.
