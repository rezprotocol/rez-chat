import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 90_000;
const POLL_MS = 200;

function parseArgs(argv) {
  const out = { executable: "", dataDir: "", launchArgs: [], cycles: 2, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = index + 1 < argv.length ? argv[index + 1] : "";
    if (token === "--executable") {
      out.executable = next;
      index += 1;
    } else if (token === "--data-dir") {
      out.dataDir = next;
      index += 1;
    } else if (token === "--arg") {
      out.launchArgs.push(next);
      index += 1;
    } else if (token === "--cycles") {
      out.cycles = Number.parseInt(next, 10);
      index += 1;
    } else if (token === "--timeout-ms") {
      out.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else {
      throw new Error("Unknown argument: " + token);
    }
  }
  return out;
}

function validateOptions({ executable, dataDir, launchArgs = [], cycles = 2, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resolvedExecutable = path.resolve(String(executable || ""));
  const resolvedDataDir = path.resolve(String(dataDir || ""));
  if (!executable || !fs.existsSync(resolvedExecutable)) {
    throw new Error("Packaged desktop executable does not exist: " + resolvedExecutable);
  }
  if (!dataDir) throw new Error("Packaged desktop verification requires dataDir");
  if (!Array.isArray(launchArgs)) throw new Error("launchArgs must be an array");
  if (!Number.isInteger(cycles) || cycles < 2 || cycles > 4) {
    throw new Error("cycles must be an integer from 2 through 4");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
    throw new Error("timeoutMs must be an integer from 5000 through 300000");
  }
  return {
    executable: resolvedExecutable,
    dataDir: resolvedDataDir,
    launchArgs: launchArgs.map((value) => String(value)),
    cycles,
    timeoutMs,
  };
}

function pathWithoutNode(envPath) {
  const entries = String(envPath || "").split(path.delimiter).filter((entry) => entry.length > 0);
  const kept = entries.filter((entry) => {
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    return !fs.existsSync(path.join(entry, nodeName));
  });
  if (kept.length === 0) {
    throw new Error("Packaged desktop verification could not construct PATH without a Node executable");
  }
  return kept.join(path.delimiter);
}

function writeIsolatedConfig(dataDir) {
  const configPath = path.join(dataDir, "rez.config.json");
  const config = {
    node: {
      ws: { host: "127.0.0.1", port: 8787, path: "/ws" },
      storage: { dataDir: path.join(dataDir, "node-data") },
      backup: { retentionDays: 1 },
      // Full-mesh mode requires local routing participation. An empty relay
      // set keeps the smoke run offline while exercising the real node path.
      network: { participateInRouting: true, knownRelays: [] },
    },
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function readLock(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0
        || !Number.isInteger(parsed.port) || parsed.port <= 0
        || typeof parsed.instanceId !== "string" || parsed.instanceId.length === 0) {
      return null;
    }
    return parsed;
  } catch (err) {
    return null;
  }
}

function readHealth(lock) {
  return new Promise((resolve) => {
    const request = http.get({
      host: "127.0.0.1",
      port: lock.port,
      path: "/health",
      timeout: 1_500,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65_536) request.destroy();
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(response.statusCode === 200
            && parsed && parsed.sidecar === true && parsed.instanceId === lock.instanceId);
        } catch (err) {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function captureOutput(child, label) {
  const chunks = [];
  const append = (source, chunk) => {
    const line = "[packaged-smoke:" + label + ":" + source + "] " + String(chunk);
    chunks.push(line);
    if (chunks.length > 100) chunks.shift();
    process.stdout.write(line);
  };
  if (child.stdout) child.stdout.on("data", (chunk) => append("stdout", chunk));
  if (child.stderr) child.stderr.on("data", (chunk) => append("stderr", chunk));
  return chunks;
}

async function waitForReady({ child, dataDir, timeoutMs, output }) {
  const lockPath = path.join(dataDir, "sidecar.lock");
  const vaultPath = path.join(dataDir, "desktop-vault.sqlite");
  const deadline = Date.now() + timeoutMs;
  let exit = null;
  let spawnError = null;
  child.once("error", (err) => {
    spawnError = err;
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error("Packaged app failed to launch: " + spawnError.message + "\n" + output.join(""));
    }
    if (exit) {
      throw new Error("Packaged app exited before readiness (code=" + String(exit.code)
        + ", signal=" + String(exit.signal || "") + ")\n" + output.join(""));
    }
    const lock = readLock(lockPath);
    if (lock && pidAlive(lock.pid) && fs.existsSync(vaultPath) && await readHealth(lock)) {
      return lock;
    }
    await delay(POLL_MS);
  }
  throw new Error("Packaged app did not become healthy within " + timeoutMs + "ms\n" + output.join(""));
}

async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await delay(POLL_MS);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateProcessTree(child) {
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Kill only the GUI host. The Windows Job Object must reap the bundled
    // sidecar; waitForPidDeath below turns a broken job fence into a failure.
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/F"]).catch((err) => {
      if (child.exitCode === null && child.signalCode === null) throw err;
    });
  } else {
    // AppImage launchers can leave the real GUI process beneath them. Put the
    // launch in its own process group and signal the whole group, including
    // descendants that inherited our stdout/stderr pipes. Killing only the
    // launcher can otherwise leave both the app and this verifier alive.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      if (!err || err.code !== "ESRCH") throw err;
    }
    if (!await waitForExit(child, 10_000)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (err) {
        if (!err || err.code !== "ESRCH") throw err;
      }
    }
  }
  await waitForExit(child, 10_000);
}

async function waitForPidDeath(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await delay(POLL_MS);
  }
  throw new Error("Sidecar process " + pid + " survived packaged-app shutdown");
}

export async function verifyPackagedDesktop(options = {}) {
  const checked = validateOptions(options);
  writeIsolatedConfig(checked.dataDir);
  const childEnv = {
    ...process.env,
    ...options.env,
    PATH: pathWithoutNode(process.env.PATH),
    REZ_CHAT_USER_DATA_DIR: checked.dataDir,
    NO_PROXY: "127.0.0.1,localhost",
  };
  if (checked.executable.toLowerCase().endsWith(".appimage")) {
    childEnv.APPIMAGE_EXTRACT_AND_RUN = "1";
  }

  let priorInstanceId = "";
  const receipts = [];
  for (let cycle = 1; cycle <= checked.cycles; cycle += 1) {
    const child = spawn(checked.executable, checked.launchArgs, {
      env: childEnv,
      cwd: path.dirname(checked.executable),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: false,
    });
    const output = captureOutput(child, "cycle-" + cycle);
    let lock = null;
    try {
      lock = await waitForReady({
        child,
        dataDir: checked.dataDir,
        timeoutMs: checked.timeoutMs,
        output,
      });
      if (lock.instanceId === priorInstanceId) {
        throw new Error("Restart reused the prior sidecar instance identity");
      }
      priorInstanceId = lock.instanceId;
      receipts.push({ cycle, instanceId: lock.instanceId, sidecarPid: lock.pid, port: lock.port });
      console.log("[packaged-smoke] cycle " + cycle + " healthy instance=" + lock.instanceId);
    } finally {
      await terminateProcessTree(child);
      if (lock) await waitForPidDeath(lock.pid, 15_000);
    }
  }
  return { executable: checked.executable, dataDir: checked.dataDir, receipts };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  verifyPackagedDesktop(parseArgs(process.argv.slice(2))).then((receipt) => {
    console.log("[packaged-smoke] PASS " + JSON.stringify(receipt));
  }).catch((err) => {
    console.error("[packaged-smoke] FAIL " + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}
