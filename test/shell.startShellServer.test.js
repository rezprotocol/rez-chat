import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";

import { ChatShellHost } from "../src/server/host/ChatShellHost.js";
import { isBindPermissionError } from "./_lifecycleUtil.js";

async function withTempUiRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rez-chat-shell-test-"));
  try {
    await fs.writeFile(path.join(dir, "index.html"), "<!DOCTYPE html><html><head><script type=module src=\"/assets/main.js\"></script></head><body></body></html>");
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

test("ChatShellHost requires uiRoot", async () => {
  assert.throws(
    () => new ChatShellHost({ wsUrl: "ws://localhost:8787/ws", port: 0 }),
    /ChatShellHost requires uiRoot/
  );
});

test("ChatShellHost requires wsUrl", async () => {
  await withTempUiRoot(async (dir) => {
    assert.throws(
      () => new ChatShellHost({ uiRoot: dir, port: 0 }),
      /ChatShellHost requires wsUrl or uplinks/
    );
  });
});

test("GET /health returns 200 and JSON with ok and tsMs", async (t) => {
  await withTempUiRoot(async (dir) => {
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json");
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.ok(typeof body.tsMs === "number" && body.tsMs > 0);
    } finally {
      await shell.stop();
    }
  });
});

test("GET /config returns 200 and JSON with wsUrl", async (t) => {
  await withTempUiRoot(async (dir) => {
    const wsUrl = "ws://localhost:9999/ws";
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl,
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const res = await fetch(`http://127.0.0.1:${port}/config`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json");
      const body = await res.json();
      assert.equal(body.wsUrl, wsUrl);
    } finally {
      await shell.stop();
    }
  });
});

test("GET / serves index.html with injected REZ_CONFIG.wsUrl", async (t) => {
  await withTempUiRoot(async (dir) => {
    const html = "<!DOCTYPE html><html><head></head><body></body></html>";
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
    const wsUrl = "ws://localhost:8781/ws";
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl,
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("__REZ_SHELL_CONFIG__"));
      assert.ok(text.includes("REZ_CONFIG"));
      assert.ok(text.includes(wsUrl));
      assert.ok(text.includes("</head>"));
    } finally {
      await shell.stop();
    }
  });
});

test("GET /missing returns 404", async (t) => {
  await withTempUiRoot(async (dir) => {
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const res = await fetch(`http://127.0.0.1:${port}/missing`);
      assert.equal(res.status, 404);
    } finally {
      await shell.stop();
    }
  });
});

test("path traversal attempt does not serve outside uiRoot (403 or 404)", async (t) => {
  await withTempUiRoot(async (dir) => {
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const res = await fetch(`http://127.0.0.1:${port}/../etc/passwd`);
      assert.ok(res.status === 403 || res.status === 404, "must not serve file outside uiRoot");
    } finally {
      await shell.stop();
    }
  });
});

test("static file returns correct content-type and body", async (t) => {
  await withTempUiRoot(async (dir) => {
    const jsContent = "console.log('hello');";
    await fs.writeFile(path.join(dir, "app.js"), jsContent, "utf8");
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const res = await fetch(`http://127.0.0.1:${port}/app.js`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("content-type")?.includes("javascript"));
      assert.equal(await res.text(), jsContent);
    } finally {
      await shell.stop();
    }
  });
});

test("stop() closes the server", async (t) => {
  await withTempUiRoot(async (dir) => {
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    const { port } = shell.address;
    await shell.stop();
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/health`),
      /ECONNREFUSED|fetch failed/
    );
  });
});

test("binds to host 0.0.0.0 when specified and is reachable on loopback", async (t) => {
  await withTempUiRoot(async (dir) => {
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "0.0.0.0",
    });
    if (!shell) return;
    try {
      const res = await fetch(`http://127.0.0.1:${shell.address.port}/health`);
      assert.equal(res.status, 200);
    } finally {
      await shell.stop();
    }
  });
});

test("CSP header is present on all responses", async (t) => {
  await withTempUiRoot(async (dir) => {
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      for (const pathname of ["/health", "/config", "/"]) {
        const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
        const csp = res.headers.get("content-security-policy");
        assert.ok(csp, `CSP header missing on ${pathname}`);
        assert.ok(csp.includes("default-src 'self'"), `default-src missing on ${pathname}`);
        assert.ok(csp.includes("script-src"), `script-src missing on ${pathname}`);
        assert.ok(csp.includes("frame-ancestors 'none'"), `frame-ancestors missing on ${pathname}`);
        assert.equal(res.headers.get("x-frame-options"), "DENY", `x-frame-options missing on ${pathname}`);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff", `x-content-type-options missing on ${pathname}`);
      }
    } finally {
      await shell.stop();
    }
  });
});

test("nonce is fresh per request and appears in injected <script>", async (t) => {
  await withTempUiRoot(async (dir) => {
    const html = "<!DOCTYPE html><html><head></head><body></body></html>";
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
    });
    if (!shell) return;
    try {
      const { port } = shell.address;

      const res1 = await fetch(`http://127.0.0.1:${port}/`);
      const res2 = await fetch(`http://127.0.0.1:${port}/`);

      const csp1 = res1.headers.get("content-security-policy");
      const csp2 = res2.headers.get("content-security-policy");

      // Extract nonce from CSP header (format: 'nonce-{base64}')
      const nonceRe = /nonce-([A-Za-z0-9+/=]+)/;
      const nonce1 = nonceRe.exec(csp1)?.[1];
      const nonce2 = nonceRe.exec(csp2)?.[1];

      assert.ok(nonce1, "nonce1 must be present in CSP");
      assert.ok(nonce2, "nonce2 must be present in CSP");
      assert.notEqual(nonce1, nonce2, "nonce must differ across requests");

      // Nonce must appear on the injected <script> tag
      const body1 = await res1.text();
      assert.ok(body1.includes(`nonce="${nonce1}"`), "nonce must appear on injected <script> tag");
    } finally {
      await shell.stop();
    }
  });
});

test("default host is 127.0.0.1 (loopback)", async (t) => {
  await withTempUiRoot(async (dir) => {
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
    });
    if (!shell) return;
    try {
      const addr = shell.address;
      assert.equal(addr.host, "127.0.0.1", "default bind host must be loopback");
    } finally {
      await shell.stop();
    }
  });
});

test("WS session.hello without valid bridgeToken is rejected", async (t) => {
  await withTempUiRoot(async (dir) => {
    const bridgeToken = "test-secret-token-abc123";
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
      bridgeToken,
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        ws.on("open", () => {
          // Send session.hello with wrong token
          ws.send(JSON.stringify({
            type: "bridge.req",
            ns: "chat",
            reqId: "r1",
            method: "session.hello",
            params: {
              accountId: "acct_test123",
              deviceId: "dev_test",
              bridgeToken: "wrong-token",
            },
          }));
        });
        ws.on("message", (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(data)));
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      assert.equal(response.ok, false, "response must not be ok");
      assert.ok(
        response.error && response.error.message && response.error.message.includes("Invalid bridge token"),
        "error must mention invalid bridge token"
      );

      ws.close();
    } finally {
      await shell.stop();
    }
  });
});

test("WS session.hello with valid bridgeToken passes token gate", async (t) => {
  await withTempUiRoot(async (dir) => {
    const bridgeToken = "test-secret-token-xyz789";
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
      bridgeToken,
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        ws.on("open", () => {
          // Send session.hello with correct token but no chatBridge — should fail at "No bridge handler", not token
          ws.send(JSON.stringify({
            type: "bridge.req",
            ns: "chat",
            reqId: "r1",
            method: "session.hello",
            params: {
              accountId: "acct_test123",
              deviceId: "dev_test",
              bridgeToken,
            },
          }));
        });
        ws.on("message", (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(data)));
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Should NOT get "Invalid bridge token" — should get past token gate
      // (will fail with "No bridge handler" since no chatBridge is configured, which is expected)
      if (response.ok === false) {
        assert.ok(
          !response.error.message.includes("Invalid bridge token"),
          "valid token must not be rejected as invalid"
        );
      }

      ws.close();
    } finally {
      await shell.stop();
    }
  });
});

test("/config endpoint does not leak bridgeToken", async (t) => {
  await withTempUiRoot(async (dir) => {
    const bridgeToken = "config-test-token-456";
    const shell = await startShellOrSkip(t, {
      uiRoot: dir,
      wsUrl: "ws://localhost:8787/ws",
      port: 0,
      host: "127.0.0.1",
      bridgeToken,
    });
    if (!shell) return;
    try {
      const { port } = shell.address;
      const res = await fetch(`http://127.0.0.1:${port}/config`);
      const body = await res.json();
      assert.equal(body.bridgeToken, undefined, "/config must not include bridgeToken");
    } finally {
      await shell.stop();
    }
  });
});
