# Chat App Spec

## 1. Scope and Ownership

- `rez-chat` is the chat SPA/app runtime.
- `rez-ui` is a reusable UI framework consumed by `rez-chat`.
- `rez-sdk` is the integration facade used by `rez-chat`.
- `rez-core` owns protocol and crypto internals.

`rez-ui` must not own chat runtime behavior, account/session logic, or network/protocol orchestration.

## 2. Runtime Responsibilities

### `rez-chat` (app)

- Owns application state machine and intent handling.
- Owns auth/unlock/connect/logout orchestration.
- Owns thread/message/inbox app workflow decisions.
- Owns the wallet + paid-services workflow: credit balance, receipts, service pricing, and `@handle` claim/renew/release.
- Calls `rez-sdk` for keystore and network-facing actions, including `WalletCapability` and `HandlesCapability`.

### `rez-ui` (framework)

- Owns rendering primitives, components, host wiring, and style assets.
- Does not talk to `rez-sdk` or `rez-core`.
- Does not own app workflows or protocol semantics.

### Wallet + paid services (REZ economy)

Rez is **postage, not equity**: core messaging is free; paid services — `@handles`, persistent storage, large files — are charged against an account credit balance.

- During beta, paid services settle on **off-chain Service Credits** via the SDK's `LocalSettlementProvider`. Credits come in two classes: `convertible` and `promotional`. The same workflow later anchors to chain settlement with no UI change.
- **Wallet account SSOT** is the session-authenticated account identity key (`accountIdentityPublicKeyB64`), displayed/stored under the derived `rez:acct:*` form. There is exactly one wallet per account.
- An `@handle` is a paid, renewable, releasable name resolvable to its owner. `@handles` are also a contact-discovery target: resolve → owner `keyId` → owner-published contact-inbox record → connect request.
- When a paid request is underfunded, the relay returns `PAYMENT_REQUIRED`; the app maps this centrally to a "not enough credits" gate with a "View wallet" action (see Section 12).

## 3. Integration Boundary

- `rez-chat` uses `rez-sdk` to communicate with rez-node/relay endpoints.
- `rez-ui` does not import `@rezprotocol/sdk`, `@rezprotocol/core`, `@rezprotocol/node`, or `rez-chat`.
- `rez-chat` does not import `@rezprotocol/core` directly.

### Storage Boundary

`rez-chat` owns application records and chooses their account partition. Persistence is supplied
through the `rez-sdk` storage facade; app services must not open files, SQL, or IndexedDB directly.
In a browser, the SDK's encrypted IndexedDB provider stores the client runtime under a database
name derived from the unlocked account ID. Desktop uses the same app/runtime interfaces over the
native vault and sidecar. Account changes reset every account-scoped UI store before another
account's runtime can hydrate it.

`rez-sdk` is responsible for storage-provider implementations, peer-link persistence, and crypto
at the storage boundary. `rez-chat` remains responsible for thread/contact/invite semantics and
their record types.

## 4. Network Integration Boundaries

- No connect until unlock succeeds.
- Unlock/connect behavior is owned by `rez-chat` app services.
- Framework rendering in `rez-ui` only reflects app state from `rez-chat`.
- Protocol and crypto details are hidden behind `rez-sdk` APIs.

### Hosted browser runtime

The browser build is a first-class application, not a desktop download page. After unlock it boots
the same client-owned chat runtime in the browser and connects by WSS to a shared hosted home.
Account signing keys, account-DH keys, device keys, ratchets, plaintext, and encrypted local app
state remain in the browser. The hosted `rez-node` cluster stores and routes ciphertext and durable
mailbox cursors only.

The desktop shell remains supported, but it is not required to use hosted chat. A mobile app-store
wrapper is a separate shell over these same app/runtime boundaries; it must not move account keys
or plaintext into the hosted node.

The web build is installable as a PWA. Its service worker may cache only the static application
shell. `/ws`, `/config`, `/health`, `/ready`, and protocol responses are always network-owned.

Browser-to-browser device linking uses the same account-blind durable-record rendezvous as desktop.
The primary browser authors the root-signed delegation, while the new browser generates and retains
its device key locally, persists the seedless delegated keystore, and then boots the normal client-
owned runtime. No Node crypto shim or hosted-node key custody is involved. Phrase recovery remains
the separate root-device recovery path.

### Browser recovery

New browser primary accounts derive their account signing and account-DH identities from a
24-word BIP39 recovery phrase. The phrase is encrypted locally under the account password. A
password change re-seals the exact keystore payload and must preserve account ID, device ID, and
device key. Phrase recovery on a fresh browser reconstructs the same account root and creates a
new device-local key. The phrase does not contain local-only message history; portable full-history
backup remains a desktop feature until a versioned browser backup format is specified.

## 5. Behavioral Requirements (Unchanged)

- App remains fail-closed while locked.
- Unlock must be explicit and validated.
- Connect/disconnect lifecycle must be deterministic and testable.
- Message flow is modeled as Rez payload/packet operations through SDK APIs.

## 6. Scenes

`rez-chat` owns scene transitions and scene state, while `rez-ui` owns rendering primitives.

- Contacts scene:
  - First-class navigation destination for relationship management.
  - Supports list/filter/rename/block/unblock through SDK-owned contact actions.
  - Primary entrypoint for invite creation.
  - Canonical contact semantics are defined in `docs/CONTACTS_SPEC.md`.
- Login/Unlock scene:
  - Presents either `NO_KEYSTORE` create-account flow or `LOCKED` unlock flow.
  - Connection actions are disabled until unlock succeeds.
- Main scene:
  - Displays thread list, selected thread timeline, and composer.
  - Uses app state from `rez-chat` stores/services only.
- New Chat/Invite scene:
  - Primary entrypoint from Contacts scene; optional entrypoint from thread list.
  - Creates or resolves target thread binding and returns to Main on success.
  - Invite acceptance errors stay fail-closed and do not silently connect.
- Create Group scene/flow:
  - First-class app path for creating a group and generating member invites.
  - Works with group-capable invite plumbing even before full group UI polish.
- Settings scene:
  - Manages app/session preferences and explicit logout action.
  - Logout always transitions to locked state and tears down active transport.
  - Hosts the Wallet panel: credit balance, receipt history, and the current service price list. Reflects live `wallet.updated` state; does not poll.
- Handle claim/renew flow:
  - Reachable from Settings; surfaces availability check, claim/renew/release, and the displayed price for the requested term.
  - Claim/renew are paid actions and are gated on sufficient credits (see Section 13 and the `PAYMENT_REQUIRED` mapping in Section 12).
- New Chat/Invite scene also accepts an `@handle` as a target:
  - The `@handle` input resolves to an owner and issues a connect request through SDK-owned contact actions, exactly like a code/QR invite, and returns to Main on success.
  - Resolution failures stay fail-closed and do not silently connect.

## 7. Thread Model

- `threadId` is stable and is the canonical thread key across refresh/reload.
- `threadId` is not equal to mailbox/capability IDs (`localInboxId` or binding target IDs).
- Active binding target resolution is app-owned orchestration in `rez-chat`, executed through SDK calls.
- Selected thread must remain deterministic after refresh:
  - Keep existing selected `threadId` when still present.
  - Otherwise choose the first valid protocol thread identifier.

## 8. Message Model

- Message states are modeled as:
  - `pending`
  - `sent`
  - `delivered`
  - `failed`
- UI rendering may show derived status labels, but canonical transitions are driven by SDK/runtime events.
- Message payloads are Rez objects; chat text is one possible payload shape, not a separate transport.

## 9. Idempotency Contract

- Outbound sends must use `clientMsgId` idempotency keys.
- Retries of the same logical send reuse the same `clientMsgId`.
- Duplicate server acknowledgements for the same `clientMsgId` must not create duplicate rendered messages.

## 10. Ordering Rules

- Primary ordering key is server acceptance timestamp / sequence when available.
- Fallback ordering key is client-observed creation/accept time when server ordering fields are absent.
- Tie-breaker ordering uses deterministic message identifiers (`messageId`, then `clientMsgId`).

## 11. Pagination Rules

- Pagination is per-thread cursoring; cursors are not shared across threads.
- pagination behavior is deterministic per thread and must never mix cursors between threads.
- Fetching older/newer pages must preserve the ordering contract in Section 10.
- Page merges must remain idempotent with respect to duplicate entries.

## 12. Network Event Boundaries

Expected event categories from runtime/SDK:
- `ack` (send accepted / canonicalized)
- `message` (inbound or reconciled timeline item)
- `receipt` (delivery/read progression)
- `error` (request or transport failure)
- `wallet` (`wallet.updated` — credit balance / receipt projection changed after a settlement)
- `handle` (`handle.updated` — `@handle` claimed/renewed/released or ownership changed)

Underlying rez-node WS message families consumed for paid services: `settlement.balance`, `settlement.receipts`, `pricing.list`, `catalog.list`, `handle.renew` (and later `storage.persist`, `file.large`).

`PAYMENT_REQUIRED` is a distinct `error` disposition: a relay returns it for an underfunded paid request. `rez-chat` maps it **centrally** (not per-call) to a "Not enough credits (need N, have M)" toast/banner with a "View wallet" action; all paid services inherit this mapping.

`rez-chat` interprets these events into app state transitions; `rez-ui` only renders resulting state.

## 13. Fail-Closed Gating

- No connect until unlock succeeds.
- If unlock fails, state returns to `LOCKED` and any partial connection attempt is torn down.
- If auth state transitions to `LOCKING`/`LOCKED`, active polling and transport activity are stopped immediately.

## 14. Navigation Actions

Required navigation actions in v0:
- Contacts -> New Chat/Invite (primary)
- Thread list -> New Chat/Invite (optional)
- Main -> Create Group (first-class path)
