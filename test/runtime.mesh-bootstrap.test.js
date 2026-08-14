import test from "node:test";
import assert from "node:assert/strict";

import { ChatBus } from "../src/ui/root/ChatBus.js";
import { ConnectionStore } from "../src/ui/stores/ConnectionStore.js";
import { RuntimeService } from "../src/ui/services/bus/RuntimeService.js";

test("RuntimeService seeds mesh state from the runtime client snapshot", async () => {
  const bus = new ChatBus({});
  const connectionStore = new ConnectionStore();
  bus.stores.connection = connectionStore;

  let meshStatusCalls = 0;
  const client = {
    onState() {
      return () => {};
    },
    onEvent() {
      return () => {};
    },
    getActiveUplink() {
      return "ws://127.0.0.1:8787/ws";
    },
    getUplinkStates() {
      return [{ url: "ws://127.0.0.1:8787/ws", active: true, ready: true, healthy: true }];
    },
    // Seeding goes through the GENERIC directive path — client.call(method, params) — not a
    // bespoke getMeshStatus() method. Transports must forward (method, params) through one entry
    // point and never enumerate bus directives (AGENTS.md / CLAUDE.md transport generality); this
    // double predated that and exposed a per-directive method, so the seed silently no-opped.
    async call(method, params) {
      assert.equal(method, "mesh.status");
      assert.deepEqual(params, {});
      meshStatusCalls += 1;
      return {
        mesh: {
          enabled: true,
          mode: "seeded-gossip",
          participateInRouting: true,
          peerCount: 4,
          seedReachable: {
            "https://r1.rezprotocol.io": true,
          },
          lastDiscoveryAtMs: 123,
          routeStats: { evicted: 0 },
          policy: { failureThreshold: 8 },
          peers: [],
        },
      };
    },
  };

  const sdkSessionService = {
    async connectClient() {
      return { accountId: "acct_test", deviceId: "dev_test", sessionHandles: {} };
    },
    getClient() {
      return client;
    },
    async disconnect() {},
  };

  const runtime = new RuntimeService({
    bus,
    sdkSessionService,
    connectionStore,
  });

  await runtime.connect();

  assert.equal(meshStatusCalls, 1);
  const connection = connectionStore.getConnection();
  assert.equal(connection.mesh.peerCount, 4);
  assert.equal(connection.mesh.seedReachable["https://r1.rezprotocol.io"], true);
});

test("RuntimeService surfaces a typed startup failure instead of presenting it as ordinary offline reconnect", async () => {
  const bus = new ChatBus({});
  const connectionStore = new ConnectionStore();
  bus.stores.connection = connectionStore;
  const failure = new Error("legacy key refused");
  failure.code = "ACCOUNT_IDENTITY_DH_MIGRATION_INVALID";
  const runtime = new RuntimeService({
    bus,
    sdkSessionService: {
      async connectClient() { throw failure; },
      getClient() { return null; },
      async disconnect() {},
    },
    connectionStore,
  });

  await assert.rejects(() => runtime.connect(), (err) => err === failure);
  const connection = connectionStore.getConnection();
  assert.equal(connection.status, "error");
  assert.match(connection.lastError, /Account upgrade could not complete safely/);
});
