# Security Policy

`rez-chat` is the reference desktop chat application for Rez. Vulnerabilities here can affect end-user keys, message integrity, and the integrity of the local relay node every install runs.

## Reporting a Vulnerability

**Please do not open public issues for suspected vulnerabilities.**

Use [GitHub Security Advisories](https://github.com/rezprotocol/rez-chat/security/advisories/new) to report privately. Only the reporter and the repository maintainers can view the report.

## What to expect

- **Acknowledgement** within 72 hours.
- **Initial assessment** (severity, scope, reproduction) within 7 days.
- **Fix + coordinated disclosure** within 90 days of report — sooner for high-severity issues.
- **Credit** in the security advisory and release notes if you'd like (let us know).

## Scope

In scope:
- Electron / preload boundary issues that expose Node APIs to renderer code
- Keystore handling, biometric/device-unlock bypasses
- IPC bridge bugs that allow privilege escalation between renderer and main process
- Local privilege escalation via the bundled rez-node or chat server
- Auto-update flaws (signature/notarization bypass, downgrade attacks)

Out of scope:
- Social engineering of users (e.g., tricking them into accepting a malicious invite)
- Issues that require operator-level access to the user's machine
- Issues affecting only un-tagged `main`-branch code

## Threat model and posture

Cross-package threat model and audit history live in [`rez-core`](https://github.com/rezprotocol/rez-core):
- [`docs/security.md`](https://github.com/rezprotocol/rez-core/blob/main/docs/security.md) — threat model + guarantees
- [`docs/SECURITY_POSTURE.md`](https://github.com/rezprotocol/rez-core/blob/main/docs/SECURITY_POSTURE.md) — audit history + disclosure posture
