import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPackagedDesktop } from "../scripts/verify-packaged-desktop.mjs";

test("packaged verifier requires two healthy starts and reaps each sidecar", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rez-packaged-smoke-"));
  const dataDir = path.join(root, "profile");
  const serverPath = path.join(root, "server.mjs");
  const launcherPath = path.join(root, "launcher.mjs");
  fs.writeFileSync(serverPath, `
    import fs from "node:fs";
    import http from "node:http";
    import path from "node:path";
    import { randomUUID } from "node:crypto";
    const dataDir = process.env.REZ_CHAT_USER_DATA_DIR;
    const instanceId = randomUUID();
    const lockPath = path.join(dataDir, "sidecar.lock");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "desktop-vault.sqlite"), "fixture-vault");
    const server = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sidecar: true, instanceId }));
    });
    const shutdown = () => server.close(() => {
      try { fs.unlinkSync(lockPath); } catch (err) { if (!err || err.code !== "ENOENT") throw err; }
      process.exit(0);
    });
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        port: address.port,
        instanceId,
        startedAtMs: Date.now(),
      }));
    });
  `, "utf8");
  fs.writeFileSync(launcherPath, `
    import { spawn } from "node:child_process";
    const server = spawn(process.execPath, [${JSON.stringify(serverPath)}], {
      stdio: "inherit",
    });
    server.on("exit", (code) => process.exit(code == null ? 1 : code));
  `, "utf8");

  try {
    const result = await verifyPackagedDesktop({
      executable: process.execPath,
      launchArgs: [launcherPath],
      dataDir,
      cycles: 2,
      timeoutMs: 10_000,
    });
    assert.equal(result.receipts.length, 2);
    assert.notEqual(result.receipts[0].instanceId, result.receipts[1].instanceId);
    assert.equal(fs.existsSync(path.join(dataDir, "sidecar.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
