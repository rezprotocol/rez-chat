import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { ServerConnectionService } from "../src/server/services/ServerConnectionService.js";

test("ServerConnectionService normalizes sdk node meshStatus wrapper payloads", async () => {
  const bus = new ChatServerBus({});
  bus.runtime.sdk = {
    node: {
      async meshStatus() {
        return {
          node: {
            accountId: "acct_test",
          },
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
          },
          peers: [],
        };
      },
    },
  };

  const service = new ServerConnectionService({ bus });
  const result = await service.getMeshStatus({});

  assert.equal(result.mesh.peerCount, 4);
  assert.equal(result.mesh.seedReachable["https://r1.rezprotocol.io"], true);
  assert.equal(result.mesh.mode, "seeded-gossip");
});
