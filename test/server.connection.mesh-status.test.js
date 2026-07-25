import test from "node:test";
import assert from "node:assert/strict";

import { ChatServerBus } from "../src/server/app/ChatServerBus.js";
import { ServerConnectionService } from "../src/server/services/ServerConnectionService.js";

// The payload shape below is exactly what MeshStatusHandler sends for node.status:
// { node, mesh, peers }. This test used to stub a `meshStatus()` method instead — a method no
// NodeCapability has ever exposed — which kept an unreachable branch in the service alive. The
// subject was always meshFromStatus normalization, so it now exercises the real op.
test("ServerConnectionService normalizes the node.status mesh payload", async () => {
  const bus = new ChatServerBus({});
  bus.runtime.sdk = {
    node: {
      async status() {
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
