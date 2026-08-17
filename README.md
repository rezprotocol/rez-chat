# rez-chat

Reference desktop chat application for the [Rez protocol](https://github.com/rezprotocol).

End-to-end encrypted messaging with no phone number, no central server, and no operator with access to your messages. Your Ed25519 keypair *is* your account; messages are encrypted on your device before they leave; relay nodes only see ciphertext and routing headers.

This repository contains the cross-platform Tauri 2 desktop application plus the in-app chat server that mediates between the UI and the [`@rezprotocol/sdk`](https://github.com/rezprotocol/rez-sdk) client runtime. Every desktop install runs a bundled Node sidecar and local Rez node, so every user is a first-class peer on the relay mesh.

---

## What's in here

- **Tauri 2 application shell** — native windows, system integration, updater, and supervision of the bundled Node sidecar. The shell stays transport-generic; application and protocol behavior remain in JavaScript.
- **Chat server** — local Node service that owns threads, messages, contacts, groups, channels, file transfer, and link previews. It also owns the wallet and handle services (`ServerWalletService`, `ServerHandlesService`, backed by `WalletStore` / `HandleStore`). Talks to the SDK; owns its own SQLite persistence.
- **Wallet + paid services** — core messaging stays free forever; paid services (claimed `@handles`, persistent storage, large media) settle against Service Credits. The wallet (`WalletPanelView`) and handle claim flow (`HandleClaimView`) surface balances and receipts; an underfunded request returns `PAYMENT_REQUIRED`, shown as a "not enough credits" toast. Beta runs on off-chain credits; the REZ token economy is documented in [`rez-contracts`](https://github.com/rezprotocol/rez-contracts).
- **UI** — bus-driven view layer built on [`rez-ui`](https://github.com/rezprotocol/rez-ui). Components are autonomous and reactive; the UI does not know about the protocol layer.
- **Auto-update** — signed Tauri updater artifacts published through GitHub Releases; macOS release builds are signed and notarized.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the canonical UI architecture and component model, and [docs/CHAT_APP_SPEC.md](./docs/CHAT_APP_SPEC.md) for the application behavior spec.

---

## Install

Published installers are available on the [Releases page](https://github.com/rezprotocol/rez-chat/releases). New desktop releases use the Tauri build pipeline:

| Platform | Format |
|---|---|
| macOS (arm64 + x64) | `.dmg` |
| Windows (x64) | NSIS `.exe` |
| Linux (x64) | `.AppImage`, `.deb` |

The desktop app is wired for in-place auto-update (silent download, restart-to-install banner) — once you've installed a release build, you won't need to manually upgrade for subsequent versions.

**Testing the alpha?** Read the [Tester Guide](./docs/TESTER_GUIDE.md) first — per-platform install notes (the Windows installer is not code-signed yet), what works and what doesn't, how to report problems, and the one-time relay identity cutover that will break pre-cutover clients.

---

## Building from source

### Prerequisites

- Node.js 22.x (the release pipeline and bundled sidecar are pinned to Node 22)
- npm 10+
- Rust with Cargo; this repository's `rust-toolchain.toml` pins the compiler toolchain
- Tauri CLI 2 (`cargo tauri`)
- Sibling checkouts of [`rez-core`](https://github.com/rezprotocol/rez-core), [`rez-sdk`](https://github.com/rezprotocol/rez-sdk), [`rez-node`](https://github.com/rezprotocol/rez-node), and [`rez-ui`](https://github.com/rezprotocol/rez-ui) (rez-chat consumes these as workspace deps).

### Run in development

```bash
npm install
node scripts/fetch-sidecar-node.mjs
npm run tauri:dev
```

### Build a packaged app

```bash
npm run desktop:build:web
node scripts/fetch-sidecar-node.mjs
cargo tauri build
```

The bundle is written beneath `src-tauri/target/release/bundle/`. On the matching operating system, reproduce a specific CI target by passing its target triple to both `fetch-sidecar-node.mjs` and `cargo tauri build --target`.

The `Desktop Build` GitHub Actions workflow is the canonical release path. Manual runs upload build artifacts; a `v*` tag creates a draft GitHub Release with platform installers and signed updater metadata.

### Deprecated Electron shell

The `electron/` directory, `electron-builder.yml`, Electron dependencies, and `desktop:pack:*` scripts remain temporarily as migration and comparison tooling. Electron is deprecated: it is not the supported desktop shell and is not used by the release workflow. New desktop work and release validation must target Tauri.

### Code signing + notarization (macOS)

Local macOS builds use a Developer ID Application identity already installed in the login keychain. Set these variables before running `cargo tauri build` when producing signed updater artifacts and a notarized build:

| Variable | Source |
|---|---|
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity in the keychain |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | App-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | Apple developer team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key matching the updater public key in `src-tauri/tauri.conf.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater private key |

CI imports its Developer ID certificate from `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`, maps the `APPLE_APP_SPECIFIC_PASSWORD` secret to `APPLE_PASSWORD`, deep-signs the bundled native SQLite module, and lets Tauri sign and notarize the final bundle. The complete release contract lives in [`.github/workflows/desktop-build.yml`](./.github/workflows/desktop-build.yml).

---

## Testing

```bash
npm test                  # full test suite (~5 minutes)
```

The test suite covers: domain records, store mutations, query views, the desktop bridge and sidecar lifecycle, supervisor lifecycle, server-service behavior, peer-link protocol handshakes, group fanout, channel sync, invite acceptance, message resend, and several architecture-guardrail tripwires.

---

## Documentation

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Canonical UI architecture: bus, stores, services, views, host/scene model |
| [docs/CHAT_APP_SPEC.md](./docs/CHAT_APP_SPEC.md) | Chat application behavior: threads, state machine, navigation surface |

Cross-package references:
- Protocol spec, capability model, identifiers, message lifecycle — see [`rez-core/docs/`](https://github.com/rezprotocol/rez-core/tree/main/docs)
- Hosting a relay node, mesh topology, persistence — see [`rez-node/docs/`](https://github.com/rezprotocol/rez-node/tree/main/docs)
- UI framework primitives — see [`rez-ui/ARCHITECTURE.md`](https://github.com/rezprotocol/rez-ui/blob/main/ARCHITECTURE.md)

---

## Related projects

- [**rez-core**](https://github.com/rezprotocol/rez-core) — cryptographic primitives + protocol records
- [**rez-sdk**](https://github.com/rezprotocol/rez-sdk) — client SDK; rez-chat consumes the SDK
- [**rez-node**](https://github.com/rezprotocol/rez-node) — relay node; the desktop app bundles one and runs it locally
- [**rez-ui**](https://github.com/rezprotocol/rez-ui) — UI framework
- [**rez-contracts**](https://github.com/rezprotocol/rez-contracts) — Solidity contract suite for the REZ token economy

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security disclosures: see [SECURITY.md](./SECURITY.md).

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
