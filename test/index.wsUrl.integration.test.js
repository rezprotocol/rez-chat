import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { startRezChat } from "../src/index.js";
import { createTempRezChatConfig } from "./_configUtil.js";
import { isBindPermissionError } from "./_lifecycleUtil.js";

test("startRezChat uses CHAT_WS_URL when set and shell /config returns same wsUrl", async (t) => {
  // CHAT_WS_URL is gated to loopback hosts until Shape A ships
  // (see docs/HOSTED_NODE_DESIGN.md §10). A non-loopback URL would let a
  // remote node see plaintext. We test with an explicit 127.0.0.1 URL.
  const envKey = "CHAT_WS_URL";
  const original = process.env[envKey];
  process.env[envKey] = "ws://127.0.0.1:9999/ws";
  const fixture = await createTempRezChatConfig({ prefix: "rez-chat-wsurl-" });
  let app = null;
  try {
    try {
      app = await startRezChat({
        configPath: fixture.configPath,
        shellPort: 0,
        shellHost: "127.0.0.1",
      });
    } catch (err) {
      if (isBindPermissionError(err)) {
        t.skip("TCP/HTTP bind not permitted in this environment");
        return;
      }
      throw err;
    }
    assert.equal(app.wsUrl, "ws://127.0.0.1:9999/ws");
    const { port } = app.shell.address;
    const res = await fetch(`http://127.0.0.1:${port}/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.wsUrl, "ws://127.0.0.1:9999/ws");
  } finally {
    if (app) await app.stop();
    await fixture.cleanup();
    if (original !== undefined) process.env[envKey] = original;
    else delete process.env[envKey];
  }
});

test("startRezChat uses HOST_NODE_WS_PORT when CHAT_WS_URL unset and shell /config returns bind-host URL", async (t) => {
  const urlKey = "CHAT_WS_URL";
  const portKey = "HOST_NODE_WS_PORT";
  const originalUrl = process.env[urlKey];
  const originalPort = process.env[portKey];
  delete process.env[urlKey];
  process.env[portKey] = "8765";
  const fixture = await createTempRezChatConfig({ prefix: "rez-chat-host-port-" });
  let app = null;
  try {
    try {
      app = await startRezChat({
        configPath: fixture.configPath,
        shellPort: 0,
        shellHost: "127.0.0.1",
      });
    } catch (err) {
      if (isBindPermissionError(err)) {
        t.skip("TCP/HTTP bind not permitted in this environment");
        return;
      }
      throw err;
    }
    assert.equal(app.wsUrl, "ws://127.0.0.1:8765/ws");
    const res = await fetch(`http://127.0.0.1:${app.shell.address.port}/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.wsUrl, "ws://127.0.0.1:8765/ws");
  } finally {
    if (app) await app.stop();
    await fixture.cleanup();
    if (originalUrl !== undefined) process.env[urlKey] = originalUrl;
    else delete process.env[urlKey];
    if (originalPort !== undefined) process.env[portKey] = originalPort;
    else delete process.env[portKey];
  }
});

test("startRezChat shell binds to given host and port and /health returns 200", async (t) => {
  const fixture = await createTempRezChatConfig({ prefix: "rez-chat-shell-bind-" });
  let app = null;
  try {
    app = await startRezChat({
      configPath: fixture.configPath,
      shellPort: 0,
      shellHost: "127.0.0.1",
    });
  } catch (err) {
    await fixture.cleanup();
    if (isBindPermissionError(err)) {
      t.skip("TCP/HTTP bind not permitted in this environment");
      return;
    }
    throw err;
  }
  try {
    assert.equal(app.shell.address.host, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${app.shell.address.port}/health`);
    assert.equal(res.status, 200);
  } finally {
    await app.stop();
    await fixture.cleanup();
  }
});

test("startRezChat applies env overrides for config path, ws port, and data dir", async (t) => {
  const fixture = await createTempRezChatConfig({ prefix: "rez-chat-env-override-" });
  const dataDir = path.join(fixture.rootDir, "node-data-override");
  const original = {
    REZ_CHAT_CONFIG_PATH: process.env.REZ_CHAT_CONFIG_PATH,
    REZ_NODE_WS_PORT: process.env.REZ_NODE_WS_PORT,
    REZ_NODE_DATA_DIR: process.env.REZ_NODE_DATA_DIR,
  };
  process.env.REZ_CHAT_CONFIG_PATH = fixture.configPath;
  const wsPort = 30000 + Math.floor(Math.random() * 20000);
  process.env.REZ_NODE_WS_PORT = String(wsPort);
  process.env.REZ_NODE_DATA_DIR = dataDir;
  let app;
  try {
    try {
      app = await startRezChat({
        shellPort: 0,
        shellHost: "127.0.0.1",
      });
    } catch (err) {
      if (isBindPermissionError(err)) {
        t.skip("TCP/HTTP bind not permitted in this environment");
        return;
      }
      throw err;
    }

    assert.equal(path.resolve(app.configPath), path.resolve(fixture.configPath));
    assert.equal(app.config.node.ws.port, wsPort);
    assert.equal(path.resolve(app.config.node.storage.dataDir), path.resolve(dataDir));
    assert.equal(app.wsUrl, `ws://127.0.0.1:${wsPort}/ws`);

    const res = await fetch(`http://127.0.0.1:${app.shell.address.port}/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.wsUrl, `ws://127.0.0.1:${wsPort}/ws`);
  } finally {
    if (app) await app.stop();
    await fixture.cleanup();
    if (original.REZ_CHAT_CONFIG_PATH !== undefined) process.env.REZ_CHAT_CONFIG_PATH = original.REZ_CHAT_CONFIG_PATH;
    else delete process.env.REZ_CHAT_CONFIG_PATH;
    if (original.REZ_NODE_WS_PORT !== undefined) process.env.REZ_NODE_WS_PORT = original.REZ_NODE_WS_PORT;
    else delete process.env.REZ_NODE_WS_PORT;
    if (original.REZ_NODE_DATA_DIR !== undefined) process.env.REZ_NODE_DATA_DIR = original.REZ_NODE_DATA_DIR;
    else delete process.env.REZ_NODE_DATA_DIR;
  }
});

test("startRezChat clears invalid defaultThreadId before booting rez-node", async (t) => {
  const fixture = await createTempRezChatConfig({
    prefix: "rez-chat-default-thread-migrate-",
    defaultThreadId: "th_legacy_invalid",
  });
  let app = null;
  try {
    try {
      app = await startRezChat({
        configPath: fixture.configPath,
        shellPort: 0,
        shellHost: "127.0.0.1",
      });
    } catch (err) {
      if (isBindPermissionError(err)) {
        t.skip("TCP/HTTP bind not permitted in this environment");
        return;
      }
      throw err;
    }
    assert.equal(app.config.node.storage.defaultThreadId, null);
  } finally {
    if (app) await app.stop();
    await fixture.cleanup();
  }
});
