# rez-chat

Reference desktop chat application for the [Rez protocol](https://github.com/rezprotocol).

End-to-end encrypted messaging with no phone number, no central server, and no operator with access to your messages. Your Ed25519 keypair *is* your account; messages are encrypted on your device before they leave; relay nodes only see ciphertext and routing headers.

This repository contains the desktop application — Electron-based, cross-platform — plus the in-app chat server that mediates between the UI and the [`@rezprotocol/sdk`](https://github.com/rezprotocol/rez-sdk) client runtime. Every desktop install runs a local Rez node, so every user is a first-class peer on the relay mesh.

---

## What's in here

- **Electron application shell** — main process, preload bridge, native module wiring for SQLite + WebSockets.
- **Chat server** — local Node service that owns threads, messages, contacts, groups, channels, file transfer, and link previews. Talks to the SDK; owns its own SQLite persistence.
- **UI** — bus-driven view layer built on [`rez-ui`](https://github.com/rezprotocol/rez-ui). Components are autonomous and reactive; the UI does not know about the protocol layer.
- **Auto-update** — `electron-updater` integration with GitHub Releases; signed and notarized macOS builds.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the canonical UI architecture and component model, and [docs/CHAT_APP_SPEC.md](./docs/CHAT_APP_SPEC.md) for the application behavior spec.

---

## Install

Pre-built binaries are not yet published. Once the first tagged release lands, signed and notarized installers will appear on the [Releases page](https://github.com/rezprotocol/rez-chat/releases):

| Platform | Format |
|---|---|
| macOS (arm64 + x64) | `.dmg`, `.zip` |
| Windows (x64) | NSIS installer, `.zip` |
| Linux (x64) | `.AppImage`, `.zip` |

The desktop app is wired for in-place auto-update (silent download, restart-to-install banner) — once you've installed a release build, you won't need to manually upgrade for subsequent versions.

For now, build from source.

---

## Building from source

### Prerequisites

- Node.js 20+
- npm 10+
- Sibling checkouts of [`rez-core`](https://github.com/rezprotocol/rez-core), [`rez-sdk`](https://github.com/rezprotocol/rez-sdk), [`rez-node`](https://github.com/rezprotocol/rez-node), and [`rez-ui`](https://github.com/rezprotocol/rez-ui) (rez-chat consumes these as workspace deps).

### Run in development

```bash
npm install
npm run desktop:dev
```

### Build a packaged app

```bash
npm run desktop:pack:mac    # macOS .dmg + .zip (signed + notarized if env vars set)
npm run desktop:pack:dir    # platform-agnostic unpacked dir (fastest dev iteration)
```

Windows and Linux builds are produced by CI on tag push via `electron-builder`'s `--win` and `--linux` targets directly; the `electron-builder.yml` config already declares the targets (NSIS + zip for Windows, AppImage + zip for Linux).

### Code signing + notarization (macOS)

Set these environment variables before running `desktop:pack:mac` for a signed, notarized build:

| Variable | Source |
|---|---|
| `CSC_NAME` | Keychain identity, e.g. `"Your Name (TEAMID)"` |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | Apple developer team ID |

Forks without Apple credentials should set `CSC_IDENTITY_AUTO_DISCOVERY=false` to produce an unsigned dev build.

---

## Testing

```bash
npm test                  # full test suite (~5 minutes)
```

The test suite covers: domain records, store mutations, query views, IPC layer, supervisor lifecycle, server-service behavior, peer-link protocol handshakes, group fanout, channel sync, invite acceptance, message resend, and several architecture-guardrail tripwires.

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

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security disclosures: see [SECURITY.md](./SECURITY.md).

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
