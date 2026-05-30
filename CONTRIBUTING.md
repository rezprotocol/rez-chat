# Contributing to rez-chat

Thanks for considering a contribution. `rez-chat` is the reference desktop chat application — the user-facing surface of the Rez ecosystem. Please read this before opening a PR.

## Getting started

```bash
git clone https://github.com/rezprotocol/rez-chat.git
cd rez-chat
npm install
npm run desktop:dev
```

You'll also want sibling checkouts of [`rez-core`](https://github.com/rezprotocol/rez-core), [`rez-sdk`](https://github.com/rezprotocol/rez-sdk), [`rez-node`](https://github.com/rezprotocol/rez-node), and [`rez-ui`](https://github.com/rezprotocol/rez-ui) if you're working on cross-package changes.

## Code style

This codebase is **vanilla JavaScript, ESM only**.

- ES2022+: async/await, classes, native `import` / `export`
- `#privateField` / `#privateMethod()` for private members; `_protectedMethod()` convention for protected
- **No optional chaining (`?.`)** — use explicit `if` / `===` checks
- **No empty `catch` blocks** — every caught exception must be handled or re-thrown
- No TypeScript, no Babel/SWC, no transpilation
- Tests use Node's built-in `node:test` runner

## Architecture

`rez-chat` follows a strict bus + autonomous-component architecture documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md). Key invariants worth knowing before you touch the code:

- **UI components are autonomous and bus-reactive** — they subscribe to the bus directly; parents own membership, never push state into children.
- **Directives are calls, events are notifications** — user actions are `bus.call(...)`; "X happened" is `bus.emit(...)`. Don't conflate them.
- **No per-directive facades in transport code** — IPC, WS, and HTTP must dispatch generically via the bus spec; never enumerate bus directives in transport code.
- **Persist first, never patch in-memory snapshots** — the database is truth; snapshots are projections built after writes.
- **No conditional return fields** — return shapes must be uniform; callers assume always-populated.

Cross-package layer responsibilities live in [`rez-core/docs/ARCHITECTURE_GUARANTEES.md`](https://github.com/rezprotocol/rez-core/blob/main/docs/ARCHITECTURE_GUARANTEES.md).

## Tests

```bash
npm test                  # full suite (~5 minutes)
```

All PRs must pass tests and the architectural guardrail suite (`test/architecture.*.test.js`). Crypto-touching changes additionally require un-mocked end-to-end coverage — mocked tests have repeatedly hidden crypto-correctness bugs in this codebase.

## Pull request process

1. Fork → branch → push.
2. Open a PR against `main`.
3. Describe the change concretely (what + why; the *what* should match the diff).
4. CI runs tests + guardrails + desktop builds.
5. Maintainer review.

## Licensing

By submitting a contribution, you agree that your contribution will be licensed under the Apache License 2.0, the license of this repository (per Section 5 of the Apache License).

## Security disclosures

Please do **not** open public issues for security vulnerabilities. See [SECURITY.md](./SECURITY.md) for the disclosure process.
