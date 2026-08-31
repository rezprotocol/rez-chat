import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { bytesToBase64, MemoryStorageProvider as CoreMemoryStorageProvider } from "@rezprotocol/core";
import { NodeCryptoProvider, startRezNode } from "@rezprotocol/node";

import { InboxClaimant } from "../src/server/inbox/InboxClaimant.js";
import { ServerRuntimeService } from "../src/server/services/ServerRuntimeService.js";
import { AccountControlChannel } from "../src/server/runtime/AccountControlChannel.js";
import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { bootstrapChatServer } from "../src/server/bootstrap/bootstrapChatServer.js";
import { bootstrapChatRuntime } from "../src/server/bootstrap/bootstrapChatRuntime.js";
import { resolveSessionMode } from "../src/index.js";

// F8 acceptance (plans/F8_REZCHAT_ROLE_SPLIT_PLAN.md) — two tracks:
//
//   PRIVACY TRACK: for the per-device/transient mailbox shape, the ordinary
//   mailbox lifecycle runs entirely through a claimant-authenticated session —
//   zero ACCOUNT sessions, zero account-pubkey exposure, zero deviceId
//   exposure, from process start through steady state.
//
//   LEGACY TRACK: the PG shared-home configuration REPORTS itself as the
//   identity-bearing legacy path ("account-legacy"), so a green privacy suite
//   can never be misread as hosted homes having the same property (F9).

const CRYPTO = new NodeCryptoProvider();

class MemoryKV {
  #m = new Map();
  async get(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  async set(k, v) { this.#m.set(k, v); }
  async delete(k) { this.#m.delete(k); }
}
class MemoryStorageProvider {
  #kv = new MemoryKV();
  getKeyValueStore() { return this.#kv; }
}

function accountIdentity() {
  const kp = CRYPTO.generateSigningKeyPair();
  return { publicKeyB64: bytesToBase64(kp.publicKey), privateKeyB64: bytesToBase64(kp.privateKey) };
}

function freshBus() {
  return new ChatServerBus({ config: {}, logger: { log() {}, warn() {}, error() {} } });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ---- InboxClaimant key-role split ----

test("F8: a NEW claim mints a fresh random claimant key — never the account identity (asserted, not conventional)", async () => {
  const identity = accountIdentity();
  const claimant = await InboxClaimant.bootstrap({
    storageProvider: new MemoryStorageProvider(),
    cryptoProvider: CRYPTO,
    identity,
  });
  assert.notEqual(claimant.claimantPublicKeyB64, identity.publicKeyB64,
    "accountIdentityPublicKey !== inboxClaimantPublicKey");
  const session = claimant.sessionClaimantIdentity();
  assert.equal(session.claimantPublicKeyB64, claimant.claimantPublicKeyB64);
  assert.ok(session.privateKeyB64, "the session credential carries the claim private key");
});

test("F8 migration (F9 decision 1): an EXISTING legacy identity-keyed claim is KEPT as a claimant-only credential — no rotation, no new claim", async () => {
  const identity = accountIdentity();
  const storageProvider = new MemoryStorageProvider();
  // Seed the store the way the pre-F8 code did: claimant key == identity.
  const { InboxClaimStore } = await import("@rezprotocol/sdk/client");
  const store = new InboxClaimStore({ storageProvider, cryptoProvider: CRYPTO });
  await store.hydrate();
  const legacy = await store.persist(await store.createClaim({ identity }));
  await storageProvider.getKeyValueStore().set("chat-server:inbox:primary:v1", legacy.inboxId);

  const claimant = await InboxClaimant.bootstrap({ storageProvider, cryptoProvider: CRYPTO, identity });
  assert.equal(claimant.inboxId, legacy.inboxId, "the legacy inbox survives");
  assert.equal(claimant.claimantPublicKeyB64, identity.publicKeyB64,
    "same bytes continue — the historical linkage is acknowledged, not 'fixed' by destructive rotation");
});

// ---- PRIVACY TRACK: the kill shot, over a real local fs node ----

test("F8 kill shot: claimant-mode chat runtime — claim + pull over a real node with ZERO account sessions, account keys, or deviceIds on the wire", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-f8-"));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}));
  const wsPort = await getFreePort();
  const nodeApp = await startRezNode({
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: "/ws" },
      storage: { dataDir: path.join(tmpDir, "node-data") },
      network: { participateInRouting: true, knownRelays: [] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5, policy: { defaultHops: 1, forceOnionRouting: false } },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  });
  t.after(() => nodeApp.stop().catch(() => {}));
  const wsUrl = "ws://127.0.0.1:" + wsPort + "/ws";

  const identity = accountIdentity();
  const claimant = await InboxClaimant.bootstrap({
    storageProvider: new MemoryStorageProvider(),
    cryptoProvider: CRYPTO,
    identity,
  });

  // Frame observation: every frame ANY socket sends, plus a socket count.
  const sentFrames = [];
  let socketsOpened = 0;
  const wsFactory = (url) => {
    socketsOpened += 1;
    const ws = new WebSocket(url);
    const realSend = ws.send.bind(ws);
    ws.send = (data, ...rest) => {
      try { sentFrames.push(JSON.parse(String(data))); } catch { /* not JSON */ }
      return realSend(data, ...rest);
    };
    return ws;
  };

  const bus = freshBus();
  // Minimal inbound-pipeline stub: the push bridge requires one; this test's
  // subject is the session/identity surface, not deposit processing.
  bus.services = { inboundPipeline: { submit: async () => ({ status: "noop" }) } };
  const runtime = new ServerRuntimeService({
    bus,
    identity,
    uplinks: [wsUrl],
    inboxClaimant: claimant,
    wsFactory,
    sessionMode: "claimant",
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => runtime.disconnect().catch(() => {}));

  await runtime.connect();

  // The mode is visible at the orchestration level.
  assert.equal(bus.runtime.sessionMode, "claimant");
  assert.equal(runtime.sessionMode, "claimant");
  assert.equal(bus.runtime.multiDeviceFanout, false);

  // Ordinary mailbox work on the SAME session (steady state).
  const list = await runtime.sdk.mailbox.list({ mailboxId: claimant.inboxId });
  assert.ok(list, "the claimed inbox lists through the claimant session");

  // THE ASSERTIONS: zero account hellos, zero account-key bytes, zero deviceIds.
  const hellos = sentFrames.filter((f) => String(f.t || f.type || "") === "session.hello");
  assert.ok(hellos.length >= 1, "the handshake happened");
  for (const hello of hellos) {
    assert.equal(hello.body.authMode, "claimant", "every hello on every socket is claimant-mode");
    assert.equal(hello.body.claimantPublicKeyB64, claimant.claimantPublicKeyB64);
    assert.ok(!("accountIdentityPublicKeyB64" in hello.body), "no account identity field in any hello");
    assert.ok(!("deviceId" in hello.body), "no deviceId field in any hello");
  }
  const allBytes = JSON.stringify(sentFrames);
  assert.ok(!allBytes.includes(identity.publicKeyB64),
    "the account public key appears in NO frame this runtime ever sent");
  assert.equal(socketsOpened >= 1, true);
  // No second, account-authenticated connection was ever constructed: the
  // account capabilities do not exist on the data-plane client at all.
  assert.throws(() => runtime.sdk.devices, /account-mode/);
  assert.throws(() => runtime.sdk.accountOutbox, /account-mode/);
});

// ---- F9 guard: misconfiguration fails loudly, never downgrades ----

test("F9 guard: claimant mode against a durable-advertising home REFUSES with an explicit error — it never silently switches to the account path", async () => {
  const bus = freshBus();
  const fakeSdk = {
    async connect() {},
    getSessionInfo() { return { capabilities: { durableInbox: true } }; },
    connectivity: null,
  };
  const runtime = new ServerRuntimeService({
    bus,
    identity: accountIdentity(),
    uplinks: ["ws://unused.test/ws"],
    sdk: fakeSdk,
    inboxClaimant: { claimStore: null, inboxId: "inbox:" + "c".repeat(24), claimantPublicKeyB64: "K", sessionClaimantIdentity() { return { claimantPublicKeyB64: "K", privateKeyB64: "P" }; } },
    sessionMode: "claimant",
    logger: { log() {}, warn() {}, error() {} },
  });
  await assert.rejects(() => runtime.connect(), /F9/, "the refusal names the finding");
  await assert.rejects(() => runtime.connect(), /account-legacy/, "and says what to configure instead");
});

// ---- LEGACY TRACK: the default path labels itself ----

test("legacy track: the default configuration reports the identity-bearing path — a green privacy suite cannot be misread as covering it", () => {
  const bus = freshBus();
  const runtime = new ServerRuntimeService({
    bus,
    identity: accountIdentity(),
    uplinks: ["ws://unused.test/ws"],
    sdk: { async connect() {}, getSessionInfo() { return {}; } },
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(runtime.sessionMode, "account-legacy");
  assert.equal(bus.runtime.sessionMode, "account-legacy");
});

test("F9 Option B: runtime bootstrap selects legacy claims for shared-home sessions and v2 leases for claimant sessions", async () => {
  const legacyIdentity = { ...accountIdentity(), accountId: "rez:acct:" + "a".repeat(64) };
  const legacy = await bootstrapChatRuntime({
    identity: legacyIdentity,
    storageProvider: new CoreMemoryStorageProvider(),
    cryptoProvider: CRYPTO,
    uplinks: ["ws://unused.test/ws"],
    sessionMode: "account-legacy",
    logger: { log() {}, warn() {}, error() {} },
  });
  const legacyClaim = legacy.inboxClaimant.claimStore.get(legacy.inboxClaimant.inboxId);
  assert.equal(legacyClaim.generation, undefined, "shared-home claim keeps the legacy wire/storage contract");
  assert.equal(legacyClaim.closePublicKeyB64, undefined);

  const portableIdentity = { ...accountIdentity(), accountId: "rez:acct:" + "b".repeat(64) };
  const portable = await bootstrapChatRuntime({
    identity: portableIdentity,
    storageProvider: new CoreMemoryStorageProvider(),
    cryptoProvider: CRYPTO,
    uplinks: ["ws://unused.test/ws"],
    sessionMode: "claimant",
    logger: { log() {}, warn() {}, error() {} },
  });
  const portableClaim = portable.inboxClaimant.claimStore.get(portable.inboxClaimant.inboxId);
  assert.equal(portableClaim.generation, 1, "claimant topology keeps the portable lease contract");
  assert.equal(typeof portableClaim.closePublicKeyB64, "string");
});

// ---- F8.1: the SHIPPING desktop launcher uses the claimant path ----

test("F8.1: resolveSessionMode — claimant ONLY where the launcher knows its topology (own sidecar, primary); external/delegated/override → legacy or explicit", (t) => {
  const saved = {};
  for (const k of ["CHAT_SESSION_MODE", "CHAT_WS_URL", "HOST_NODE_WS_PORT"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  t.after(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  assert.equal(resolveSessionMode({ delegatedShape: false }), "claimant",
    "own local fs sidecar + primary identity → claimant");
  assert.equal(resolveSessionMode({ delegatedShape: true }), "account-legacy",
    "delegated identity (hosted-coupled flow) → legacy");

  process.env.CHAT_WS_URL = "ws://127.0.0.1:9999/ws";
  assert.equal(resolveSessionMode({ delegatedShape: false }), "account-legacy",
    "an external node this launcher did not boot → topology unknown → legacy");
  delete process.env.CHAT_WS_URL;

  process.env.HOST_NODE_WS_PORT = "8765";
  assert.equal(resolveSessionMode({ delegatedShape: false }), "account-legacy");
  delete process.env.HOST_NODE_WS_PORT;

  process.env.CHAT_SESSION_MODE = "account-legacy";
  assert.equal(resolveSessionMode({ delegatedShape: false }), "account-legacy", "explicit override wins");
  process.env.CHAT_SESSION_MODE = "claimant";
  assert.equal(resolveSessionMode({ delegatedShape: true }), "claimant", "explicit override wins over the delegated default too");
  process.env.CHAT_SESSION_MODE = "yolo";
  assert.throws(() => resolveSessionMode({}), /CHAT_SESSION_MODE/);
});

test("F8.1: a claimant-mode desktop boot — real bootstrapChatServer + full ChatServerApp start against a real local node uses the claimant path end-to-end", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-f81-"));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}));
  const wsPort = await getFreePort();
  const nodeApp = await startRezNode({
    node: {
      ws: { host: "127.0.0.1", port: wsPort, path: "/ws" },
      storage: { dataDir: path.join(tmpDir, "node-data") },
      network: { participateInRouting: true, knownRelays: [] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5, policy: { defaultHops: 1, forceOnionRouting: false } },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
    },
  });
  t.after(() => nodeApp.stop().catch(() => {}));
  const nodeIdentity = nodeApp.runtime.getIdentity();

  const bootstrapped = await bootstrapChatServer({
    nodeDataDir: path.join(tmpDir, "chat-data"),
    wsUrl: "ws://127.0.0.1:" + wsPort + "/ws",
    expectedNodePublicKeyB64: nodeIdentity.nodePublicKeyB64,
    sessionMode: "claimant",
    logger: { log() {}, warn() {}, error() {} },
  });
  t.after(() => bootstrapped.chatServer.stop().catch(() => {}));
  await bootstrapped.chatServer.start();

  const bus = bootstrapped.chatServer.bus;
  assert.equal(bus.runtime.sessionMode, "claimant", "the running desktop stack is on the claimant path");
  assert.equal(bus.runtime.sdk.authMode, "claimant", "the data-plane client authenticates as CLAIMANT");
  assert.notEqual(bootstrapped.inboxClaimant.claimantPublicKeyB64, bootstrapped.identity.publicKeyB64,
    "claimant key != account key on the shipping boot path");
  assert.throws(() => bus.runtime.sdk.devices, /account-mode/,
    "no account capability exists on the data-plane client");
  assert.ok(bus.runtime.accountControl instanceof AccountControlChannel);
  assert.equal(bus.runtime.accountControl.active, false,
    "no ACCOUNT session was constructed during ordinary startup");
});

// ---- AccountControlChannel: demand-driven, batched, never sticky ----

function fakeControlClientFactory() {
  const built = [];
  return {
    built,
    factory: async () => {
      const client = {
        connected: false,
        disconnected: false,
        async connect() { this.connected = true; },
        async disconnect() { this.disconnected = true; this.connected = false; },
      };
      built.push(client);
      return client;
    },
  };
}

test("AccountControlChannel: opens ONLY on demand, batches within the idle window, closes on idle, and never reopens without new control work", async () => {
  const { built, factory } = fakeControlClientFactory();
  const channel = new AccountControlChannel({
    identity: accountIdentity(),
    uplinks: ["ws://unused.test/ws"],
    clientFactory: factory,
    idleCloseMs: 40,
    logger: { log() {}, warn() {}, error() {} },
  });

  // Demand-driven: constructing the channel opens NOTHING.
  assert.equal(built.length, 0);
  assert.equal(channel.active, false);

  // op1 opens A…
  await channel.execute(async (client) => { assert.equal(client.connected, true); });
  assert.equal(built.length, 1);
  assert.equal(channel.active, true);

  // …op2 inside the idle window REUSES A…
  await new Promise((r) => setTimeout(r, 10));
  await channel.execute(async () => {});
  assert.equal(built.length, 1, "batching reuses the already-needed session");

  // …idle timeout CLOSES A…
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(channel.active, false, "idle close fired");
  assert.equal(built[0].disconnected, true);

  // …and nothing reopens it without new control-plane work (non-stickiness).
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(built.length, 1, "no proactive reconnect ever happens");

  // The next genuine control op builds a FRESH bounded session.
  await channel.execute(async () => {});
  assert.equal(built.length, 2);
  await channel.close();
  assert.equal(channel.active, false);
  await assert.rejects(() => channel.execute(async () => {}), /closed/);
});
