import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { InstanceLock } from "../src/desktop/sidecar/InstanceLock.js";
import { ParentWatchdog } from "../src/desktop/sidecar/ParentWatchdog.js";
import { HostChannel } from "../src/desktop/sidecar/HostChannel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");
const SIDECAR_ENTRY = path.join(CHAT_ROOT, "src", "desktop", "sidecar-main.js");
const MARKER = HostChannel.MARKER;

let nodeWsPortCounter = 38000 + Math.floor(Math.random() * 1000);
function nextNodeWsPort() {
  nodeWsPortCounter += 1;
  return nodeWsPortCounter;
}

function makeDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rez-sidecar-" + label + "-"));
}

function sidecarEnv(dataDir, extra = {}) {
  return {
    ...process.env,
    REZ_CHAT_USER_DATA_DIR: dataDir,
    REZ_CONTROL_TOKEN: "lifecycle-test-token",
    REZ_CHAT_SKIP_UI_CHECK: "1",
    REZ_NODE_WS_PORT: String(nextNodeWsPort()),
    REZ_SIDECAR_PPID_POLL_MS: "200",
    ...extra,
  };
}

/**
 * Collect HostChannel protocol frames from a stdout stream; resolves the
 * returned promise with the params of the first frame matching `op`.
 */
function waitForFrame(stream, op, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for frame '" + op + "'. output so far:\n" + buffer));
    }, timeoutMs);
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split("\n")) {
        if (!line.startsWith(MARKER)) continue;
        let frame = null;
        try {
          frame = JSON.parse(line.slice(MARKER.length));
        } catch (err) {
          continue;
        }
        if (frame && frame.op === op) {
          clearTimeout(timer);
          resolve(frame);
          return;
        }
      }
    });
  });
}

function waitForExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("sidecar did not exit within " + timeoutMs + "ms"));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function spawnSidecar(dataDir, envExtra = {}) {
  const child = spawn(process.execPath, [SIDECAR_ENTRY, "--rez-sidecar"], {
    env: sidecarEnv(dataDir, envExtra),
    stdio: ["pipe", "pipe", "pipe"],
    cwd: CHAT_ROOT,
  });
  child.stderr.on("data", () => {});
  return child;
}

test("sidecar exits cleanly when its stdin closes (parent death, primary layer)", async () => {
  const dataDir = makeDataDir("stdin-eof");
  const child = spawnSidecar(dataDir);
  const ready = await waitForFrame(child.stdout, "ready");
  assert.ok(Number.isInteger(ready.params.port) && ready.params.port > 0);
  const lockPath = path.join(dataDir, "sidecar.lock");
  assert.ok(fs.existsSync(lockPath), "lock written after boot");

  const startedAt = Date.now();
  child.stdin.end();
  const { code } = await waitForExit(child, 6000);
  const elapsed = Date.now() - startedAt;
  assert.equal(code, 0);
  assert.ok(elapsed <= 5000, "exit took " + elapsed + "ms, expected <= 5000ms");
  assert.ok(!fs.existsSync(lockPath), "lock released on shutdown");
});

test("sidecar exits via ppid backstop when parent is SIGKILLed (stdin kept open)", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only intermediate-parent simulation");
    return;
  }
  const dataDir = makeDataDir("ppid");
  // Intermediate parent: bash spawns the sidecar and waits. SIGKILL on bash
  // orphans the sidecar WITHOUT closing our pipe (the test runner still
  // holds the write end of stdin), isolating the ppid detector.
  // The explicit `0<&0` redirect stops bash from re-pointing the background
  // job's stdin at /dev/null — the sidecar keeps OUR pipe, which stays open.
  const parent = spawn(
    "bash",
    ["-c", `"${process.execPath}" "${SIDECAR_ENTRY}" --rez-sidecar 0<&0 & wait`],
    {
      env: sidecarEnv(dataDir),
      stdio: ["pipe", "pipe", "pipe"],
      cwd: CHAT_ROOT,
    },
  );
  parent.stderr.on("data", () => {});
  const ready = await waitForFrame(parent.stdout, "ready");
  const sidecarPid = ready.params.pid;
  assert.ok(Number.isInteger(sidecarPid) && sidecarPid > 0);
  assert.ok(pidAlive(sidecarPid));

  parent.kill("SIGKILL");
  // Poll interval is 200ms in tests + 3s graceful budget — well within 10s.
  const gone = await waitForPidGone(sidecarPid, 10000);
  assert.ok(gone, "sidecar should exit after its parent is SIGKILLed");
});

test("sidecar performs graceful shutdown on host 'shutdown' request", async () => {
  const dataDir = makeDataDir("host-shutdown");
  const child = spawnSidecar(dataDir);
  await waitForFrame(child.stdout, "ready");

  child.stdin.write(MARKER + JSON.stringify({ kind: "req", id: "req-1", op: "shutdown", params: {} }) + "\n");
  const { code } = await waitForExit(child, 6000);
  assert.equal(code, 0);
  assert.ok(!fs.existsSync(path.join(dataDir, "sidecar.lock")));
});

test("sidecar boots through a stale lock left by a dead pid", async () => {
  const dataDir = makeDataDir("stale-lock");
  // A guaranteed-dead pid: spawn something short-lived and wait for it.
  const ephemeral = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = ephemeral.pid;
  await new Promise((resolve) => ephemeral.on("exit", resolve));

  const lockPath = path.join(dataDir, "sidecar.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: deadPid,
    port: 1,
    instanceId: "stale-instance",
    startedAtMs: Date.now() - 60000,
  }));

  const child = spawnSidecar(dataDir);
  const ready = await waitForFrame(child.stdout, "ready");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(lock.instanceId, ready.params.instanceId, "lock now belongs to the new instance");
  assert.notEqual(lock.instanceId, "stale-instance");

  child.stdin.end();
  await waitForExit(child, 6000);
});

test("instance lock cleanup never kills a live process it cannot verify", async () => {
  const dataDir = makeDataDir("foreign-pid");
  // A live process WITHOUT the --rez-sidecar cmdline marker.
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  const lockPath = path.join(dataDir, "sidecar.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: bystander.pid,
    port: 1,
    instanceId: "not-ours",
    startedAtMs: Date.now(),
  }));

  const lock = new InstanceLock({ lockPath, instanceId: "new-instance", logger: { warn() {} } });
  const result = await lock.cleanupStale();
  assert.equal(result.action, "removed-unverified");
  assert.ok(!fs.existsSync(lockPath), "stale lock removed");
  assert.ok(pidAlive(bystander.pid), "bystander process must NOT be killed");
  bystander.kill("SIGKILL");
});

test("instance lock cleanup kills a verified abandoned sidecar", async () => {
  const dataDir = makeDataDir("verified-kill");
  const orphan = spawnSidecar(dataDir);
  const ready = await waitForFrame(orphan.stdout, "ready");
  const lockPath = path.join(dataDir, "sidecar.lock");
  assert.ok(fs.existsSync(lockPath));

  // A new instance booting against the same data dir reaps the old one:
  // cmdline marker matches AND /health echoes the lock's instanceId.
  const lock = new InstanceLock({ lockPath, instanceId: "successor", logger: { warn() {} } });
  const result = await lock.cleanupStale();
  assert.equal(result.action, "killed");
  assert.ok(!fs.existsSync(lockPath));
  const gone = await waitForPidGone(ready.params.pid, 5000);
  assert.ok(gone, "abandoned sidecar should be terminated");
  // Reap the direct child handle too (it may already be gone).
  orphan.kill("SIGKILL");
});

test("parent watchdog unit: fires on ppid change", () => {
  const fakeProcess = {
    ppid: 100,
    kill() {},
  };
  return new Promise((resolve) => {
    const wd = new ParentWatchdog({
      pollMs: 20,
      onParentGone: (reason) => {
        wd.stop();
        assert.match(reason, /ppid changed/);
        resolve();
      },
      processRef: fakeProcess,
      logger: { warn() {} },
    });
    wd.start();
    fakeProcess.ppid = 1;
  });
});

test("parent watchdog unit: fires when the parent pid stops existing", () => {
  const fakeProcess = {
    ppid: 4242,
    kill() {
      const err = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    },
  };
  return new Promise((resolve) => {
    const wd = new ParentWatchdog({
      pollMs: 20,
      onParentGone: (reason) => {
        wd.stop();
        assert.match(reason, /no longer exists/);
        resolve();
      },
      processRef: fakeProcess,
      logger: { warn() {} },
    });
    wd.start();
  });
});
