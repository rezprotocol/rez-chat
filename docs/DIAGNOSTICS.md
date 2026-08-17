# Diagnostics and crash reporting — privacy posture

This is the settled answer to "what may a bug report contain, and where may it
go" for Rez Chat. It is written down because the mechanism is easy to change
later and the posture is not: once telemetry ships, removing it is a promise you
have already broken.

## The posture

**Nothing is transmitted. Ever. There is no endpoint.**

Rez Chat has no crash-reporting service, no telemetry, no analytics, and no
opt-in that turns any of those on. When something goes wrong, the app can build
a **redacted diagnostic bundle** and hand it to the user. What happens next is
entirely the user's decision: they can read it, ignore it, or attach it to a bug
report themselves.

## Why this and not a crash service

Rez Chat's whole claim is that no operator can see your messages. A crash
reporter is an operator who receives data from your machine when things go
wrong — which is exactly when the data is most likely to contain the thing that
broke. Stack traces carry account ids, peer ids, thread ids, and sometimes
message fragments. Redaction bugs are common and are discovered publicly.

A third-party service (Sentry and friends) would give the best tooling and the
worst story: "we don't see your messages, but our error vendor might, if our
scrubber has a bug." Self-hosting fixes the vendor problem and leaves the rest —
it is still a service that receives data from users' machines, still something
to secure, still a thing to be wrong about.

Local-only has no such failure mode. There is nothing to leak because there is
nowhere to leak to. The cost is real and accepted: **weaker signal.** We only
hear about problems a tester cares enough to report. For an alpha with a small
group of testers, that trade is correct. If it stops being correct, the decision
gets revisited *here* first, not in a pull request that quietly adds a DSN.

## What a bundle contains

Built by `ServerDiagnosticsService`, redacted by `src/server/diagnostics/redact.js`:

- App version, platform, arch, Node version, uptime
- Home-node capabilities (`durableInbox`, `multiDeviceFanout`, `delegatedDevices`)
- **Counts** of contacts, groups, channels — never the rows
- The last 100 `app.error` events: source, severity, redacted message, redacted
  error with a path-stripped stack
- How many older error events were dropped from the ring buffer

## What a bundle never contains

- Message content, drafts, previews, file names
- Keys, seeds, mnemonics, passwords, signatures, ciphertext
- Invite codes or device-link codes (removed entirely — not truncated, since
  they carry live key material)
- Full account, device, inbox, thread, group or message identifiers
- Contact names, display names, avatars
- Absolute filesystem paths (they carry the OS username)

Identifiers that survive do so as a **short prefix plus a marker** —
`rez:acct:uasw…<redacted>`. That is enough to tell that two events involve the
same account, and far too little to say which one. Preserving that much is
deliberate: without it, a multi-party bug report is unreadable.

## The rules that make this hold

1. **Redaction happens at capture, not at export.** The ring buffer never holds
   an unredacted value, so no future export path can leak something that was
   retained in the clear. Pinned by a test that mutates the source event after
   capture and asserts the bundle does not follow.
2. **Deny by default for object keys.** Content-bearing keys (`text`, `body`,
   `payload`, `displayName`, `inviteCode`, …) are **dropped**, not emptied — an
   empty string still confirms a value existed.
3. **The bar is "assume this is published."** Bundles do not leave the machine
   on their own, but testers attach them to public issues. Every rule above is
   written for that, not for the weaker "it stays local" standard.
4. **Redaction lives in one place.** `redact.js` is the only implementation;
   callers must not hand-roll their own.
5. **No silent truncation.** The bundle reports how many events it dropped, so a
   bounded buffer never reads as "only this much went wrong."

## If this ever changes

Adding any transmission path means revisiting this document *first* and, at
minimum:

- opt-in, off by default, with a prompt that says plainly what is sent
- the exact payload documented here before the code lands
- a way for a user to see a bundle before it is sent

Do not add a transmission path as an implementation detail of something else.
