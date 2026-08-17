# Rez Chat — Alpha Tester Guide

Thanks for testing. This page tells you how to install it, what actually works
today, and where to send problems.

Rez Chat is **alpha software**. It is not audited, it has known gaps, and you
should not use it for anything you would be upset to lose or to have go wrong.

---

## Read this first: the relay reset has happened

This was a **one-time, breaking cutover**, and it is now done (2026-08-17).

Rez relays moved to self-certifying identities — a relay's ID is now a hash of
its own key, rather than something configured by whoever runs it. This removes
an operator's ability to claim an identity they don't hold the key for.

**What this means for you: any build older than `v0.6.0-rc.6` can no longer
connect.** Not "degrades", not "reconnects slowly" — it fails to authenticate
against every relay and stays offline. That includes `v0.5.2`, which is still
the release marked *Latest* on the Releases page.

So:

- **You need `v0.6.0-rc.6` or newer.** Nothing earlier can reach the network.
- If the app cannot connect and reinstalling the same version doesn't help,
  you are on a pre-cutover build. Get the current release.
- Auto-update carries anyone already on a `v0.6.0-rc.*` Tauri build. It does
  **not** rescue `v0.5.2` or earlier — those need a manual reinstall.

---

## Install

Grab the newest release from the
[Releases page](https://github.com/rezprotocol/rez-chat/releases).

> **Check the version — this one matters.** The release marked **Latest** is
> still `v0.5.2` from June, which cannot connect at all since the relay reset.
> Take the newest **pre-release** (`v0.6.0-rc.6` or later), *not* the one
> labelled Latest.

| Platform | Download | Notes |
|---|---|---|
| macOS, Apple Silicon | `Rez.Chat_<version>_aarch64.dmg` | signed + notarized |
| macOS, Intel | `Rez.Chat_<version>_x64.dmg` | signed + notarized |
| Windows x64 | `Rez.Chat_<version>_x64-setup.exe` | **not** code-signed — see below |
| Linux x64 | `Rez.Chat_<version>_amd64.AppImage` | `chmod +x` before running |
| Linux x64 (Debian/Ubuntu) | `Rez.Chat_<version>_amd64.deb` | `sudo dpkg -i <file>` |

The `.sig` files sitting next to the downloads are for the in-app updater, not
for you to verify by hand. Ignore them.

### macOS

Open the `.dmg`, drag the app to Applications, launch it. That's the whole
thing — builds are signed with a Developer ID certificate and notarized by
Apple, so Gatekeeper lets them through on first run.

If you *do* get "cannot be opened because the developer cannot be verified",
something is wrong with that build. Don't work around it with right-click-Open
or `xattr -d`. Tell us instead — a notarized build failing Gatekeeper is a real
problem and we want to know.

### Windows

The installer is **not code-signed**, so SmartScreen will interrupt you:

> Windows protected your PC

Click **More info** → **Run anyway**.

We would rather not ask you to click through a security warning. Code signing
needs a certificate we haven't bought yet. If clicking through isn't acceptable
to you — entirely reasonable — please don't; test on another platform or sit
this one out.

### Linux

```bash
chmod +x Rez.Chat_<version>_amd64.AppImage
./Rez.Chat_<version>_amd64.AppImage
```

Or for the `.deb`:

```bash
sudo dpkg -i Rez.Chat_<version>_amd64.deb
```

---

## What works

- Creating an account. Your keypair *is* your account — no phone number, no
  email, no signup server.
- Adding a contact by invite code, and 1:1 messaging.
- Groups: create, invite, roster, messaging.
- Channels within a group.
- File transfer and link previews.
- Messages sent while you are offline arrive when you come back.
- Auto-update: it downloads in the background and offers a restart.

## What does not work yet

- **Multi-device is not available on a normal desktop install.** A desktop app
  is its own home node, and a single node is single-device by construction. The
  "Link a new device" button is hidden unless your account lives on a hosted
  (Postgres-backed) home, because there it genuinely cannot work. This is a
  deliberate design boundary, not a missing feature we forgot.
- **No account recovery.** Lose the device or the vault password and the account
  is gone. There is no reset, and no one can restore it for you. Do not put
  anything irreplaceable in here.
- **No mobile client.**
- Group membership changes can take a moment to converge across members.
- The wallet and paid services (`@handles`, persistent storage, large media) run
  on off-chain credits. Core messaging is free and stays free.

## Known rough edges

- A peer who has been offline for a long time may take a few seconds to sync on
  reconnect.
- Very large groups are untested. If you are pushing past a handful of members,
  we want to hear what happens.

---

## Reporting problems

**Security issues — do not open a public issue.** Use
[GitHub Security Advisories](https://github.com/rezprotocol/rez-chat/security/advisories/new).
Only you and the maintainers can see it. See [SECURITY.md](../SECURITY.md).
This applies to anything where the *content or metadata of messages* leaks, not
only to obvious exploits — if you can see something about someone you shouldn't
be able to see, that's a security report.

**Everything else** — open an issue at
<https://github.com/rezprotocol/rez-chat/issues>.

What makes a report useful:

- **Version and platform.** Exact release tag, and the OS.
- **What you did, what you expected, what happened.** In that order.
- **Whether it happened once or reproducibly**, and how you triggered it. "It
  happened once and I can't reproduce it" is still worth filing — just say so.
- **How many people were involved** and whether it was a DM, a group, or a
  channel. Most interesting bugs live in the multi-party paths.
- **Rough timestamp**, so it can be matched against logs.

Please **do not paste message contents, invite codes, or anything from your
vault** into an issue. Issues are public. Describe the shape of the problem
instead; if we need more, we'll ask through a private channel.

Redact account IDs (`rez:acct:...`) unless the bug is specifically about
identity. A prefix like `rez:acct:uasw…` is plenty to correlate.

---

## Where your data lives

Everything is local: the vault, message history, and node state all sit on your
machine. Nothing is uploaded, and there is no server-side copy — which is the
point, and also why there is no recovery. Relays see ciphertext and routing
headers, never plaintext.

Uninstalling leaves your data directory behind. If you want a genuinely clean
slate, remove it too:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/com.rezprotocol.chat` |
| Windows | `%APPDATA%\com.rezprotocol.chat` |
| Linux | `~/.local/share/com.rezprotocol.chat` |

If you used an older **Electron** build of Rez Chat, your data may still live at
the previous `Rez Chat` path (`~/Library/Application Support/Rez Chat`,
`%APPDATA%\Rez Chat`, `~/.config/Rez Chat`). The app migrates it on first launch
by renaming the directory, but if that rename is blocked it keeps using the old
location and retries next time — so check both before concluding you've wiped
everything.

Deleting that directory destroys the account. There is no undo.
