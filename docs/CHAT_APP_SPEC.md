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
- Calls `rez-sdk` for keystore and network-facing actions.

### `rez-ui` (framework)

- Owns rendering primitives, components, host wiring, and style assets.
- Does not talk to `rez-sdk` or `rez-core`.
- Does not own app workflows or protocol semantics.

## 3. Integration Boundary

- `rez-chat` uses `rez-sdk` to communicate with rez-node/relay endpoints.
- `rez-ui` does not import `@rezprotocol/sdk`, `@rezprotocol/core`, `@rezprotocol/node`, or `rez-chat`.
- `rez-chat` does not import `@rezprotocol/core` directly.

### Storage Boundary

`rez-chat` does not access storage directly.
All thread, contact, and invite state is accessed through `rez-sdk`.
`rez-sdk` is responsible for:
- Constructing derived views (thread index)
- Managing invite lifecycle state
- Persisting app metadata via StorageProvider namespaces.

## 4. Network Integration Boundaries

- No connect until unlock succeeds.
- Unlock/connect behavior is owned by `rez-chat` app services.
- Framework rendering in `rez-ui` only reflects app state from `rez-chat`.
- Protocol and crypto details are hidden behind `rez-sdk` APIs.

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
