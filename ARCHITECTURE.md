# rez-chat UI Architecture (Canonical)

Status: Canonical / normative.
Scope: rez-chat — the chat application UI built on rez-ui (framework) and rez-sdk (protocol/runtime).
Last lean refactor: 2026-05.

---

## 0) Non-Negotiables

1. **One-way flow only**: `Sources → Services → Stores → Views → DOM`.
2. **Stores own truth**. **Services orchestrate IO**. **Views patch their own subtree**.
3. **No mega-render**. No file rebuilds the entire DOM on every change.
4. **Views never call services directly** — they emit intents (or read sync from stores).
5. **Services never touch DOM**.
6. **rez-chat may depend on rez-ui + rez-sdk; never rez-core directly.**
7. **No optional chaining** anywhere in this codebase.
8. **No silent catches**. All caught exceptions handled or re-emitted as `app.error`.

---

## 1) Rendering Model — Components All The Way Down

> Every UI node is a `Component`. There is no `Scene` vs `View` distinction.
> A Component owns a DOM mount point and its own lifecycle. It is a container
> that holds zero or more child Components, recursively, until you reach a
> leaf that just writes to the DOM.
>
> Every Component subscribes to the events it cares about itself.
> **Parents own membership only** — which children exist and in what order.
> **Parents never push state to children**, never call `child.update(...)`, never call `child.set*(...)`.
> The bus emits, components react. **Zero orchestration.**

### 1.1 The two framework primitives (rez-ui/framework)

- **`Component`** — base class with `mount(parentEl)`, `unmount()`, `_subscribe(store, handler)` (auto-cleanup), `render()` (override). Every UI node in rez-chat extends `BusComponent`, which is a Component plus bus access (`this.bus`, `_listen(name, handler)`).
- **`Host`** — a `Component` that holds at most one named child Component at a time and swaps it on `switchTo(name, { force? })`. Used uniformly at every level: top-level scene host, tab host inside the main scene, pane host inside the contacts tab.

### 1.2 The single navigation surface

> Click handlers do exactly **one thing**: `bus.call("ui", "<directive>", { ... })`.
> No view ever calls `uiStateStore.set*` or `host.switchTo` directly.

`UiNavigationService` is the canonical command surface:

| Directive                                                 | Effect                                                                |
|-----------------------------------------------------------|-----------------------------------------------------------------------|
| `bus.call("ui", "navigateTab", { to })`                   | Switch the main tab (`chat` / `contacts` / `settings` / `profile`).   |
| `bus.call("ui", "selectContactGroup", { groupId })`       | Open / close a group's detail pane inside the contacts tab.           |
| `bus.call("ui", "setThreadListFilters", { filters })`     | Update the chat-list filter chips.                                    |

The service writes to `UiStateStore`. Hosts subscribe to the relevant store fields and call `switchTo(...)` themselves.

### 1.3 Hosts and lifecycle

- **`ChatApp`** owns the top-level Host with children: `login-unlock | login-create | splash | main`. Driven by `_syncSceneFromSession` reading `SessionStore` + `UiStateStore`.
- **`AppShellView`** (mounted by `MainScene`) owns the tab Host with children: `chat | contacts | settings | profile`. Driven by `ui.activeTab.changed`.
- **`ContactsTabView`** owns an inner pane Host with children: `invites | group-detail`. Driven by `ui.selectedContactGroup.changed`. Group-detail uses `force: true` on switchTo when the selected group changes (to remount with the new id).

Each host's mounted child Component constructs its own DOM and instantiates its own children. Lifecycle propagates: when the host unmounts a child, that child unmounts its own children, etc.

### 1.4 List parents (ThreadListView, MessageTimelineView, ContactsTabView, GroupDetailView)

- Hold `Map<id, ChildComponent>` and a stable container element.
- Subscribe to the typed store's structured events.
- On membership change: diff current set against the new ordered IDs, **construct missing rows, destroy departed rows, reorder via `insertBefore`**.
- **Never tear down children on unrelated changes**.
- Empty/loading/error placeholders are full container swaps, not list rows.

### 1.5 Row children (ThreadListItemView, MessageBubbleView, ContactRowView, GroupRowView, GroupMemberRowView)

- Constructor takes `{ bus, id }`.
- In `mount()`, subscribe to typed stores **filtered by own id**.
- In `render()`, read sync from typed stores. No `bus.call().then()` inside `render()`.
- Click handlers issue directives via `bus.call(...)`.

### 1.6 Forbidden patterns

- A separate `Scene` vs `View` distinction (collapsed to `Component`).
- A parent calling `child.update(record)` or `child.setX(...)`.
- A view calling `uiStateStore.setActiveTab(...)` / `setSelectedContactGroupId(...)` / `setThreadListFilters(...)` directly. These go through `bus.call("ui", ...)`.
- A view calling `host.switchTo(...)` directly. The host subscribes to its own driving store field; views just issue directives.
- `bus.emit("user.wantsTo.X")` for user directives — directives are calls, emits are notifications.
- `bus.call("...", "get", {}).then((record) => ...)` inside a row's `render()`.
- `setTimeout` / `setInterval` driving UI updates instead of store events.

---

## 2) Stores (per-domain, extend StoreBase)

All chat-domain truth lives in stores at `src/ui/stores/`. Each extends `StoreBase`.

### 2.1 The store inventory

| Store              | File                | Owns                                                                 |
|--------------------|---------------------|----------------------------------------------------------------------|
| `SessionStore`     | `SessionStore.js`   | unlock state machine, `accountId`, `deviceId`, `accountList`         |
| `AuthStore`        | `AuthStore.js`      | lower-level keystore/crypto state (bootstrap, handles)               |
| `UiStateStore`     | `UiStateStore.js`   | view-only state (selectedThreadId, selectedContactGroupId, activeTab, threadListFilters) |
| `ThreadStore`      | `ThreadStore.js`    | thread map, ordering, unread counts                                  |
| `MessageStore`     | `MessageStore.js`   | per-thread message lists, optimistic-clientMsgId reconciliation      |
| `ContactStore`     | `ContactStore.js`   | contact map by `contactAccountId`                                    |
| `GroupStore`       | `GroupStore.js`     | groups + per-group members                                           |
| `InviteStore`      | `InviteStore.js`    | invite records + `lastCreatedInviteCode`                             |
| `ConnectionStore`  | `ConnectionStore.js`| WS uplink + mesh status                                              |

### 2.2 Store event contract (`StoreBase._emit`)

```js
{
  store: "<store name>",                           // "threads", "messages", "contacts", ...
  type:  "<store>.<verb>",                         // "threads.upserted", "messages.replaced", ...
  keys:  { threadId?, messageId?, contactAccountId?, ... },
  meta:  { ts: <ms>, source: "<StoreClass>" }     // auto-filled by StoreBase
}
```

Every typed store emits this shape via `StoreBase._emit(type, keys, meta?)`.
`SessionStore` and `UiStateStore` predate StoreBase but emit compatible events (`{store, type, keys}` without `meta`); consumers tolerate both.

### 2.3 Hard constraints on stores

- **No IO**: no `fetch`, no WS send, no IPC. If you need to persist, you're a service, not a store.
- **No DOM**.
- **No imports of services or transport**. Stores import records and `StoreBase` only.
- **All inputs flow through Records** (`ChatThread / ChatMessage / ChatContact / ChatGroup / ChatGroupMember / ChatInvite`). The `asRecord(...)` helpers in each store coerce ad-hoc objects to record instances.

---

## 3) Services (orchestration)

Services in `src/ui/services/bus/` own IO, request/response correlation, and store mutations. They:

- depend on the **narrowest typed store(s)** they need (ThreadsService takes `threadStore + messageStore + uiStateStore`; MessagesService takes `messageStore`; etc.);
- register their public API on `bus.functions.<ns>.<method>` via `BaseBusService._register`;
- subscribe to runtime events via `BaseBusService._listen`;
- mutate the relevant typed store; the store's emission triggers view updates.

### 3.1 Realtime / send rules (the hot path)

- **No refetch-after-write.** `MessagesService.send` does optimistic insert (`messageId === clientMsgId`, `status: "sending"`), awaits `client.sendRezPayload(...)`, and lets the server-pushed `runtime.event.message.deposited` event reconcile via `MessageStore.upsertMessage`'s clientMsgId matcher.
- **No Promise.all force-refetch in `InvitesService.accept`.** The server emits `thread.index.updated` (direct + group), `contact.updated` (via `ServerContactsService.ensureActiveContact`), and `peer-link.updated`. Client services upsert into stores directly; views see `*.upserted` events and patch.
- **`ContactsService.rename | block | unblock`**: upsert the returned record into `ContactStore`; the server's `contact.updated` event is idempotent on top.
- **`GroupsService.rename | kick | setRole | leave | createGroup`**: no force-refetch. The server emits `group.updated` / `group.removed` / `group.members.updated` from `ServerGroupsService` and `ServerThreadsService.ensureGroupThread`; client `GroupsService` listens via `runtime.event.group.*` and patches `GroupStore` directly. Self-initiated rename also upserts the returned record optimistically.
- **Cross-account group propagation** uses the `rez.group-op.v1` mailbox payload. After a local `rename | kick | setRole | leave`, `ServerGroupsService` fans out a `GroupOpPayloadV1` to every other active member (and to the kicked member, for kick) via `nodeRuntime.sendEncryptedDeposit`. On receipt, `ServerEventService` recognises the `kind` and dispatches to `ServerGroupsService.handleIncomingGroupOp`, which validates the sender (must be a current member; admin-only ops require admin role in the receiver's view) and applies the change to the local `GroupStore`. The same `group.updated / group.members.updated / group.removed` events are emitted on the receiver, flowing through to that user's UI exactly like a self-initiated change. Last-writer-wins on rename via `actedAtMs`; ops dedup at the mailbox event level.
- **`UiNavigationService`** is the canonical user-directive surface for navigation. See §1.2.

### 3.2 Optimistic-message reconciliation (`MessageStore.upsertMessage`)

When upserting a message that has a `clientMsgId`, drop any existing row whose `clientMsgId` matches but whose `messageId` differs. This collapses the optimistic-placeholder row (keyed by `clientMsgId`) into the real row (keyed by server `messageId`) on first sight of the deposit event.

`MessagesService.send` only writes the post-response "sent" status if no row with the server `messageId` exists yet — preventing a race where the deposit event already wrote `queued | delivered` and we'd downgrade it to `sent`.

---

## 4) Connection state + desktop event envelope

### 4.1 SDK pool → ConnectionStore

`ServerRuntimeService` subscribes to `sdk.onState(...)` and forwards SDK pool phase transitions as `connection.state` events. Phase mapping:

| SDK phase       | ConnectionStateEvent.status |
|-----------------|-----------------------------|
| `connected`     | `connected`                 |
| `offline`       | `offline`                   |
| `reconnecting`  | `reconnecting`              |
| `failover`      | `connecting`                |

`ConnectionStateEvent` also carries `activeUplink` and `reason`.

The renderer's `ConnectionService` listens for `runtime.event.connection.state` and writes status to `ConnectionStore`.
The renderer's `RuntimeService._bindClient` separately handles `client.onState` so the in-renderer state machine and the typed `ConnectionStore` stay in sync.

### 4.2 Desktop event envelope

Events flowing from the in-process chat-server through the supervisor to the renderer use:

```js
{
  name: "<dotted.event.name>",     // "message.deposited", "contact.updated", ...
  payload: <record JSON>,           // record-shaped, cloned
  meta:    { ts, source: "desktop-supervisor" }
}
```

`electron/runtime/DesktopSupervisor.mjs#emit` stamps `meta`. The renderer-side preload routes by `event.name`. `DesktopRuntimeClient.onEvent(name, handler)` exposes per-name subscription. `RuntimeService._bindClient` re-emits each event onto the bus as `runtime.event.<name>` for typed services to consume.

### 4.3 Connection flow at boot

1. Vault unlocks → `SessionService.unlock` → `RuntimeService.connect`.
2. `RuntimeService.connect` sets `ConnectionStore.status = "connecting"`, then `"connected"` once the SDK pool reports it.
3. SDK reconnects and failovers update `ConnectionStore.status` automatically; views (e.g. `SplashView`, `SettingsTabView`) reflect the live state without polling.

---

## 5) Display names — single resolver

All display-name resolution goes through `src/ui/presenters/labels.js`:

- `findSelfLabel(snap)` — returns the active account label or `null`.
- `resolveSelfLabel(snap)` — same, with `"Account"` fallback for UI.
- `resolvePeerLabel(contactSnap, peerAccountId)`, `resolveAccountLabel(...)`, `resolveThreadDisplayLabel(...)`, `resolveMessageSenderLabel(...)`.

No service or view maintains its own copy of self-label resolution.

Self-rename propagation: `SessionService.updateProfile` → `AuthBootstrapService.setDisplayName` → `accountRegistry.setAccountLabel` (persist) → `authStore.setAccountList` → `_syncFromAuth({keepStatus:true})` → `sessionStore.setAccountList`. Synchronous before `client.broadcastProfile()` is called, so any subsequent invite / createGroup reads see the new label.

Peer-rename propagation: `ServerProfileService.handleIncomingProfile` → `contactStore.upsert` → `contact.updated` event → `ContactsService._handleContactUpdated` → `ContactStore.upsertContact` → `contacts.upserted` → views re-resolve via `resolveAccountLabel`.

---

## 6) File / folder layout (required)

```
rez-chat/src/
  ui/
    base/             BusComponent (extends rez-ui Component)
    presenters/       labels.js, threadPresentation.js (pure derivation)
    records/          ChatRuntimeConfig, AccountRegistryData, AuthBootstrap*, etc.
    root/             ChatApp.js (composition root), ChatBus.js
    scenes/           LoginUnlockScene, LoginCreateAccountScene, SplashScene, MainScene
    services/
      auth/           AccountRegistry, AccountAuthService, AuthBootstrapService, ...
      bus/            BaseBusService, RuntimeService, ThreadsService, MessagesService,
                      ContactsService, GroupsService, InvitesService, ConnectionService,
                      SessionService, AuthScreenService, NotificationService,
                      UiNavigationService
    stores/           StoreBase + the 9 stores listed in §2.1
    views/            mounted Components: AppShellView, ChatTabView, ContactsTabView,
                      SettingsTabView, ProfileTabView, ThreadListView, ThreadPanelView,
                      and all leaf rows / pieces
  client/             runtime adapters: DesktopRuntimeClient, ChatRuntimeClient, transport bridge
  records/            domain/, events/, params/, results/ — RRecord subclasses
  server/             in-process ChatServerApp + transport bridge + ServerXxxService classes
electron/
  main.mjs, preload.cjs
  runtime/            DesktopSupervisor, DesktopVaultService,
                      registerDesktopIpc.mjs
```

---

## 7) Acceptance criteria

A change is done only when:

1. No file acts as a "render the whole app" mega-renderer.
2. UI updates flow `service → typed store → store event → view patch`. No engine-style `render(state)`.
3. List parents do not rebuild the entire list on a single-row change. Existing rows are not torn down on unrelated events.
4. Message status updates patch only the affected row (the `MessageBubbleView` listens to its own `messages.upserted`).
5. Views do not import services or transport; services do not import views.
6. `SessionStore` gating is honored: no WS connect before `UNLOCKED`; on `LOCKING`, the runtime disconnects cleanly.
7. No store does IO. No service touches DOM.
8. Send and invite-accept paths have **no force-refetch**; they rely on server-pushed events.
9. All wire payloads are records; no plain ad-hoc objects sneak across the boundary.
10. `npm test` and `npm run guardrails` both pass.

---

## 8) Known follow-ups (not blockers, captured in MCP memory and tasks)

- **Cold-boot instant-hydrate (deferred)** — chat-domain truth lives in the rez-node SDK's persistent storage at `userData/.local/rez-node-data/`; the renderer always reads through `chatServer`. If we want to render threads/messages before the chat server is fully ready on cold-boot, build a renderer-side hydrate path that reads directly from a persistent cache. The previous write-only `desktop-chat.sqlite` mirror was deleted (audit, 2026-05) — start over from requirements when this is needed.
- **Legacy bus events** — a few views still listen for `connection.updated` (`ConnectionStatusView`, `SettingsTabView`, `SplashView`) instead of subscribing to `ConnectionStore` directly. Tactical cleanup; not a correctness issue.
- **Cross-account group state propagation** — when peer A kicks peer B from a group, peer B's local `GroupStore` does not learn about it (no remote-driven group events yet). Same for role changes peer-to-peer. Will need a mailbox-message-driven path similar to `rez.profile.v1`.
- **Hosted multi-tenant rez-node** — design after the chat refactor lands; trust model (where E2EE ratchet state lives) is the open question.
