import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

import { ChatShellHost } from "../src/server/host/ChatShellHost.js";
import { CHAT_BRIDGE_SPEC } from "../src/server/transport/ChatBridge.js";
import { ChatBridgeClient } from "../src/client/transport/ChatBridgeClient.js";
import { ChatRuntimeClient } from "../src/client/runtime/ChatRuntimeClient.js";
import {
  SessionHelloResult,
  ThreadsListResult,
} from "../src/records/index.js";
import { isBindPermissionError } from "./_lifecycleUtil.js";

async function withTempUiRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-v2-shell-test-"));
  try {
    await fs.writeFile(
      path.join(dir, "index.html"),
      "<!DOCTYPE html><html><head></head><body></body></html>",
      "utf8"
    );
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function startShellOrSkip(t, options) {
  try {
    return await new ChatShellHost(options).start();
  } catch (err) {
    if (isBindPermissionError(err)) {
      t.skip("TCP/HTTP bind not permitted in this environment");
      return null;
    }
    throw err;
  }
}

function createChatBridgeStub() {
  return {
    getSpec() {
      return CHAT_BRIDGE_SPEC;
    },
    async handle(client, method, params) {
      if (method === "session.hello") {
        client.authenticate({
          accountId: params.accountId,
          deviceId: params.deviceId,
        });
        return new SessionHelloResult({
          accountId: params.accountId,
          deviceId: params.deviceId,
          ownerAccountId: "acct_owner_v2",
          localInboxId: "mbx_local_v2",
        });
      }
      if (method === "threads.list") {
        return new ThreadsListResult({
          threads: [{
            id: "th_alpha",
            threadId: "th_alpha",
            displayTitle: "Alpha",
            threadReady: true,
            sendAllowed: true,
            securityState: "ready",
            peerLinkState: "linked",
          }],
          cursor: null,
        });
      }
      throw new Error("Unhandled bridge method: " + method);
    },
  };
}

function createWsFactory() {
  return (url) => new WebSocket(url);
}

test("websocket uplink authenticates and roundtrips bridge requests", async (t) => {
  await withTempUiRoot(async (uiRoot) => {
    const shell = await startShellOrSkip(t, {
      uiRoot,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
      bridgeToken: "bridge-token-v2",
      chatBridge: createChatBridgeStub(),
      chatServer: new EventEmitter(),
    });
    if (!shell) return;
    shell.bridge.setReady(true);

    const client = new ChatBridgeClient({
      wsUrl: `ws://127.0.0.1:${shell.address.port}/ws`,
      wsFactory: createWsFactory(),
    });

    try {
      await client.connect();

      await assert.rejects(
        () => client.call("threads.list", { limit: 10 }),
        (err) => err && err.code === "NOT_AUTHENTICATED"
      );

      const session = await client.sessionHello({
        accountId: "acct_client_v2",
        deviceId: "dev_client_v2",
        bridgeToken: "bridge-token-v2",
      });
      assert.equal(session.accountId, "acct_client_v2");
      assert.equal(session.ownerAccountId, "acct_owner_v2");
      assert.equal(session.localInboxId, "mbx_local_v2");

      const threads = await client.call("threads.list", { limit: 10 });
      assert.equal(Array.isArray(threads.threads), true);
      assert.equal(threads.threads.length, 1);
      assert.equal(threads.threads[0].displayTitle, "Alpha");
      assert.equal(threads.threads[0].threadReady, true);
      assert.equal(threads.threads[0].sendAllowed, true);
    } finally {
      client.close();
      await shell.stop();
    }
  });
});

test("websocket uplink fans out authenticated server events", async (t) => {
  await withTempUiRoot(async (uiRoot) => {
    const chatServer = new EventEmitter();
    const shell = await startShellOrSkip(t, {
      uiRoot,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
      bridgeToken: "bridge-token-v2",
      chatBridge: createChatBridgeStub(),
      chatServer,
    });
    if (!shell) return;
    shell.bridge.setReady(true);

    const client = new ChatBridgeClient({
      wsUrl: `ws://127.0.0.1:${shell.address.port}/ws`,
      wsFactory: createWsFactory(),
    });

    try {
      await client.connect();
      await client.sessionHello({
        accountId: "acct_client_v2",
        deviceId: "dev_client_v2",
        bridgeToken: "bridge-token-v2",
      });

      const deposited = new Promise((resolve, reject) => {
        const off = client.onEvent("message.deposited", (event) => {
          off();
          resolve(event);
        });
        setTimeout(() => {
          off();
          reject(new Error("timed out waiting for message.deposited"));
        }, 5000);
      });

      const meshUpdated = new Promise((resolve, reject) => {
        const off = client.onEvent("mesh.updated", (event) => {
          off();
          resolve(event);
        });
        setTimeout(() => {
          off();
          reject(new Error("timed out waiting for mesh.updated"));
        }, 5000);
      });

      chatServer.emit("message.deposited", {
        threadId: "th_alpha",
        message: {
          threadId: "th_alpha",
          messageId: "msg_1",
          body: "hello from server",
        },
      });
      chatServer.emit("mesh.updated", {
        mesh: {
          enabled: true,
          mode: "seeded-gossip",
          participateInRouting: true,
          peerCount: 1,
          seedReachable: { "http://seed.local": true },
          lastDiscoveryAtMs: 123,
          routeStats: { evicted: 0 },
          policy: { failureThreshold: 8 },
          peers: [],
        },
      });

      const event = await deposited;
      const meshEvent = await meshUpdated;
      assert.equal(event.threadId, "th_alpha");
      assert.equal(event.message.messageId, "msg_1");
      assert.equal(meshEvent.mesh.peerCount, 1);
    } finally {
      client.close();
      await shell.stop();
    }
  });
});

test("runtime client uses websocket uplink for session bootstrap", async (t) => {
  await withTempUiRoot(async (uiRoot) => {
    const shell = await startShellOrSkip(t, {
      uiRoot,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
      bridgeToken: "bridge-token-v2",
      chatBridge: createChatBridgeStub(),
      chatServer: new EventEmitter(),
    });
    if (!shell) return;
    shell.bridge.setReady(true);

    const client = new ChatRuntimeClient({
      wsUrl: `ws://127.0.0.1:${shell.address.port}/ws`,
      accountId: "acct_client_v2",
      deviceId: "dev_client_v2",
      bridgeToken: "bridge-token-v2",
      wsFactory: createWsFactory(),
    });

    try {
      await client.connect();
      const session = client.getSessionInfo();
      assert.equal(session.accountId, "acct_client_v2");
      assert.equal(session.ownerAccountId, "acct_owner_v2");

      const threads = await client.call("threads.list", { limit: 10 });
      assert.equal(Array.isArray(threads.threads), true);
      assert.equal(threads.threads[0].threadId, "th_alpha");
    } finally {
      await client.close();
      await shell.stop();
    }
  });
});
