import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Runs the artifact's actual sidecar, SQLite binding, vault, SDK and local node.
// OS keychain/biometric probes are unavailable in this synthetic password-vault
// fixture. This does not claim acceptance of those native user interactions.
const [nodeArgument, resourcesArgument, profileArgument] = process.argv.slice(2);
assert.ok(nodeArgument && resourcesArgument && profileArgument,
  "Usage: verify-packaged-session.mjs <bundled-node> <resources> <synthetic-upgrade-profile>");
const nodeExecutable = fs.realpathSync(nodeArgument);
const resources = fs.realpathSync(resourcesArgument);
const profile = path.resolve(profileArgument);
assert.ok(fs.existsSync(path.join(profile, "upgrade-vault-account.txt")),
  "Requires a synthetic fixture from verify-desktop-upgrade.mjs");
const load = (relative) => import(pathToFileURL(path.join(resources, relative)));
const { HostChannel } = await load("src/desktop/sidecar/HostChannel.js");
const { encodeControlValue, decodeControlValue } = await load("src/desktop/transport/ControlFrameCodec.js");
const require = createRequire(path.join(resources, "package.json"));
const WebSocket = require("ws");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const controlToken = randomBytes(32).toString("hex");

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const selected = server.address().port;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
fs.writeFileSync(path.join(profile, "rez.config.json"), JSON.stringify({
  node: {
    ws: { host: "127.0.0.1", port, path: "/ws" },
    storage: { dataDir: path.join(profile, "node-data") },
    backup: { retentionDays: 1 },
    network: { participateInRouting: true, knownRelays: [] },
  },
}));
const child = spawn(nodeExecutable, [path.join(resources, "src/desktop/sidecar-main.js"), "--rez-sidecar"], {
  cwd: resources,
  env: {
    ...process.env,
    REZ_CHAT_USER_DATA_DIR: profile,
    REZ_CONTROL_TOKEN: controlToken,
    REZ_CHAT_SKIP_UI_CHECK: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const exited = new Promise((resolve, reject) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
  child.once("error", reject);
});
const log = fs.createWriteStream(path.join(profile, "packaged-session-child.log"));
child.stdout.on("data", (chunk) => log.write(chunk));
child.stderr.on("data", (chunk) => log.write(chunk));
const host = new HostChannel({
  input: child.stdout,
  output: child.stdin,
  onRequest: async (op) => {
    if (op === "badge.set" || op === "ready") return null;
    if (op === "keychain.probe" || op === "biometric.isAvailable") return { available: false };
    throw new Error("Unexpected host capability " + op);
  },
}).start();
let socket = null;

try {
  let lock;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Packaged sidecar exited before readiness");
    try {
      lock = JSON.parse(fs.readFileSync(path.join(profile, "sidecar.lock"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (lock && lock.pid === child.pid) break;
    await sleep(100);
  }
  assert.ok(lock && lock.pid === child.pid, "Packaged sidecar must become ready");
  socket = new WebSocket("ws://127.0.0.1:" + lock.port + "/control");
  const pending = new Map();
  let next = 0;
  let helloResolve;
  let helloReject;
  const hello = new Promise((resolve, reject) => {
    helloResolve = resolve;
    helloReject = reject;
  });
  socket.on("error", helloReject);
  socket.on("message", (bytes) => {
    const frame = JSON.parse(String(bytes));
    if (frame.op === "hello.ok") {
      helloResolve();
      return;
    }
    if (frame.op !== "result") return;
    const call = pending.get(frame.id);
    if (!call) return;
    pending.delete(frame.id);
    clearTimeout(call.timer);
    if (!frame.ok) return call.reject(new Error(frame.error.message));
    const result = decodeControlValue(frame.payload);
    if (!result.ok) return call.reject(new Error(result.error.message));
    call.resolve(result.result);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const helloTimer = setTimeout(() => helloReject(new Error("Control hello timeout")), 10_000);
  socket.send(JSON.stringify({ op: "hello", controlToken }));
  try {
    await hello;
  } finally {
    clearTimeout(helloTimer);
  }
  // The existing generic control grammar and artifact's codec carry every
  // call. This test introduces no message sender or per-directive facade.
  const call = (channel, args = {}) => new Promise((resolve, reject) => {
    const id = String(++next);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Control timeout: " + channel));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ op: "call", id, channel, args: encodeControlValue(args) }));
  });
  const accountId = fs.readFileSync(path.join(profile, "upgrade-vault-account.txt"), "utf8");
  const ownerAccountId = fs.readFileSync(path.join(profile, "upgrade-network-account.txt"), "utf8");
  await assert.rejects(() => call("desktop:vault:unlock", { accountId, password: "wrong password" }));
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await call("desktop:vault:unlock", { accountId, password: "synthetic private artifact upgrade fixture" });
    const connected = await call("desktop:runtime:connect");
    assert.equal(connected.connected, true);
    assert.equal(connected.ownerAccountId, ownerAccountId);
    const nodeStatus = await call("bus:call", { method: "node.status", params: {} });
    assert.ok(nodeStatus.status.node, "Real packaged node.status round trip required");
    const page = await call("bus:call", {
      method: "thread.messages.list",
      params: { threadId: "th:artifact-upgrade", limit: 50 },
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].text, "Encrypted message retained from old installer");
    assert.equal(page.items[0].status, "delivered");
    await call("desktop:vault:lock");
    const status = await call("desktop:runtime:status");
    assert.equal(status.runtimeConnected, false);
    assert.equal(status.lockIncomplete, false);
  }
} finally {
  if (socket) socket.close();
  let shutdownError = null;
  try {
    if (child.exitCode === null) {
      try {
        await host.request("shutdown");
      } catch (error) {
        shutdownError = error;
      } finally {
        child.stdin.end();
      }
    }
    const result = await Promise.race([exited, sleep(12_000).then(() => null)]);
    if (!result) {
      child.kill("SIGKILL");
      throw new Error("Packaged sidecar failed to stop");
    }
    assert.equal(result.code, 0);
  } finally {
    host.stop();
    log.end();
  }
  if (shutdownError) throw shutdownError;
}
console.log("PASS: packaged sidecar completed two unlock/node-RPC/history/lock cycles over the rc.10 encrypted fixture and exited cleanly");
