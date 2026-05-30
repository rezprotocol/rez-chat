import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createDefaultRezConfig } from "../src/server/config/defaultRezConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CHAT_ROOT, "..");
const ARTIFACT_UI_ROOT = path.resolve(REPO_ROOT, "artifacts", "rez-chat");
const RELAY_INFO_PATH = path.resolve(REPO_ROOT, "relays", "relay-info.json");

const requestedShellPortA = Number.parseInt(process.env.CHAT_PORT_A || "3000", 10);
const requestedShellPortB = Number.parseInt(process.env.CHAT_PORT_B || "3001", 10);
const requestedWsPortA = Number.parseInt(process.env.REZ_NODE_WS_PORT_A || "8787", 10);
const requestedWsPortB = Number.parseInt(process.env.REZ_NODE_WS_PORT_B || "8788", 10);
const requestedRelayPortA = Number.parseInt(process.env.REZ_RELAY_PORT_A || "9787", 10);
const requestedRelayPortB = Number.parseInt(process.env.REZ_RELAY_PORT_B || "9788", 10);
const dataDirA = process.env.REZ_NODE_DATA_DIR_A || path.join(CHAT_ROOT, ".local", "dev-mesh", "a-data");
const dataDirB = process.env.REZ_NODE_DATA_DIR_B || path.join(CHAT_ROOT, ".local", "dev-mesh", "b-data");
const configPathA = process.env.REZ_CHAT_CONFIG_PATH_A || path.join(CHAT_ROOT, ".local", "dev-mesh", "a.config.json");
const configPathB = process.env.REZ_CHAT_CONFIG_PATH_B || path.join(CHAT_ROOT, ".local", "dev-mesh", "b.config.json");
const baseConfigPath = process.env.REZ_CHAT_BASE_CONFIG_PATH || path.join(CHAT_ROOT, "rez.config.json");
const proofMode = String(process.env.REZ_MESH_PROOF_MODE || "").trim() === "1";
const proofHopsRaw = Number.parseInt(process.env.REZ_MESH_PROOF_HOPS || "1", 10);
const proofHops = Number.isInteger(proofHopsRaw) ? Math.max(1, Math.min(3, proofHopsRaw)) : 1;

function timestampText() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function createTimestampedLineWriter(prefix, stream) {
  let pending = "";
  return (chunk) => {
    const text = pending + String(chunk);
    const lines = text.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      stream.write(`${timestampText()} ${prefix} ${line}\n`);
    }
  };
}

function startInstance(label, env) {
  const childEnv = { ...process.env };
  // Ensure local-first behavior for dev:mesh regardless of shell env leftovers.
  delete childEnv.CHAT_WS_URL;
  delete childEnv.REZ_CHAT_WS_URL;
  delete childEnv.HOST_NODE_WS_PORT;
  delete childEnv.REZ_CHAT_DISABLE_NODE;
  Object.assign(childEnv, env);
  const child = spawn("npm", ["--prefix", CHAT_ROOT, "run", "start"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const writeStdout = createTimestampedLineWriter(`[${label}]`, process.stdout);
  const writeStderr = createTimestampedLineWriter(`[${label}]`, process.stderr);
  child.stdout.on("data", (chunk) => writeStdout(chunk));
  child.stderr.on("data", (chunk) => writeStderr(chunk));
  return child;
}

function ensureRootNodeModules() {
  const rootModules = path.join(REPO_ROOT, "node_modules");
  if (!fs.existsSync(rootModules)) {
    throw new Error("node_modules not found at repo root. Run `npm install` from repo root.");
  }
}

function findViteBin() {
  const rootBin = path.join(REPO_ROOT, "node_modules", ".bin", "vite");
  const chatBin = path.join(CHAT_ROOT, "node_modules", ".bin", "vite");
  if (fs.existsSync(rootBin)) return rootBin;
  if (fs.existsSync(chatBin)) return chatBin;
  return null;
}

async function buildUi() {
  const viteBin = findViteBin();
  if (!viteBin) throw new Error("vite not found. Run `npm install` from repo root.");
  await new Promise((resolve, reject) => {
    const child = spawn(viteBin, ["build"], {
      cwd: CHAT_ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rez-chat build failed with exit code ${code}`));
    });
  });
  if (!fs.existsSync(ARTIFACT_UI_ROOT)) {
    throw new Error(`rez-chat build did not produce ${ARTIFACT_UI_ROOT}`);
  }
}

function canListenOnPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function choosePort({ requested, envVar }) {
  const envSet = typeof process.env[envVar] === "string" && process.env[envVar].trim().length > 0;
  if (envSet) return requested;
  if (await canListenOnPort(requested)) return requested;
  if (await canListenOnPort(0)) return 0;
  return requested;
}

async function waitForShellConfig(baseUrl, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/config`, { cache: "no-store" });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && typeof json.wsUrl === "string" && json.wsUrl.trim().length > 0) {
          return json;
        }
      }
    } catch {
      // keep retrying until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/config`);
}

function loadBaseKnownRelays(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const relays = parsed?.node?.network?.knownRelays;
    return Array.isArray(relays) ? relays : [];
  } catch {
    return [];
  }
}

function loadRelayInfo() {
  try {
    const raw = fs.readFileSync(RELAY_INFO_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.relays) ? parsed.relays : [];
  } catch {
    return [];
  }
}

function normalizeKnownRelaysFromRelayInfo(knownRelays, relayInfoRows) {
  const infoRows = Array.isArray(relayInfoRows) ? relayInfoRows : [];
  if (infoRows.length === 0) return Array.isArray(knownRelays) ? knownRelays : [];

  const byHostPort = new Map();
  for (const row of infoRows) {
    const host = String(row?.ip || "").trim();
    const relayPort = Number(row?.relayPort);
    const directoryUrl = String(row?.directoryUrl || "").trim();
    if (!host || !Number.isInteger(relayPort) || relayPort <= 0 || !directoryUrl) continue;
    byHostPort.set(`${host}:${relayPort}`, directoryUrl);
  }

  const out = [];
  for (const relay of Array.isArray(knownRelays) ? knownRelays : []) {
    const next = relay && typeof relay === "object" ? { ...relay } : {};
    const host = String(next.host || "").trim();
    const port = Number(next.port);
    const key = host && Number.isInteger(port) && port > 0 ? `${host}:${port}` : "";
    if (key && byHostPort.has(key)) {
      next.directoryUrl = byHostPort.get(key);
    }
    out.push(next);
  }
  return out;
}

function ensureConfigShape(config) {
  const out = config && typeof config === "object" ? config : {};
  if (!out.node || typeof out.node !== "object") out.node = {};
  if (!out.node.ws || typeof out.node.ws !== "object") out.node.ws = {};
  if (!out.node.storage || typeof out.node.storage !== "object") out.node.storage = {};
  if (!out.node.network || typeof out.node.network !== "object") out.node.network = {};
  if (!out.node.mesh || typeof out.node.mesh !== "object") out.node.mesh = {};
  return out;
}

function mergeConfig(defaults, override) {
  const out = structuredClone(defaults);
  const src = override && typeof override === "object" ? override : {};
  if (src.node && typeof src.node === "object") {
    out.node = { ...out.node, ...src.node };
    if (src.node.ws && typeof src.node.ws === "object") {
      out.node.ws = { ...out.node.ws, ...src.node.ws };
    }
    if (src.node.storage && typeof src.node.storage === "object") {
      out.node.storage = { ...out.node.storage, ...src.node.storage };
    }
    if (src.node.network && typeof src.node.network === "object") {
      out.node.network = { ...out.node.network, ...src.node.network };
    }
    if (src.node.mesh && typeof src.node.mesh === "object") {
      out.node.mesh = { ...out.node.mesh, ...src.node.mesh };
    }
    if (src.node.relay && typeof src.node.relay === "object") {
      out.node.relay = { ...out.node.relay, ...src.node.relay };
    }
  }
  return out;
}

function rotateList(list, offset) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (arr.length <= 1) return arr;
  const n = ((offset % arr.length) + arr.length) % arr.length;
  return arr.slice(n).concat(arr.slice(0, n));
}

function writeMeshConfig({
  targetConfigPath,
  knownRelays,
  rotation,
  dataDir,
  relayPort,
  peerRelayPort,
  proofModeEnabled = false,
}) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(targetConfigPath, "utf8"));
  } catch {
    existing = {};
  }
  const defaults = createDefaultRezConfig({ dataDir: path.resolve(dataDir) });
  const next = ensureConfigShape(mergeConfig(defaults, existing));
  next.node.storage.dataDir = path.resolve(dataDir);
  next.node.network.participateInRouting = true;
  const relays = rotateList(
    Array.isArray(knownRelays) ? JSON.parse(JSON.stringify(knownRelays)) : [],
    rotation,
  );
  // In normal dev mode we add the local peer relay to allow fast direct routing.
  // In proof mode we intentionally disable this shortcut.
  if (!proofModeEnabled && peerRelayPort) {
    relays.push({ id: "local:peer", host: "127.0.0.1", port: peerRelayPort, transport: "tcp" });
  }
  next.node.network.knownRelays = relays;
  next.node.mesh.enabled = true;
  next.node.mesh.mode = "seeded-gossip";
  next.node.mesh.seeds = relays
    .map((relay) => String(relay?.directoryUrl || "").trim())
    .filter((url, idx, arr) => url.length > 0 && arr.indexOf(url) === idx);
  if (!next.node.mesh.policy || typeof next.node.mesh.policy !== "object") {
    next.node.mesh.policy = {};
  }
  if (proofModeEnabled) {
    next.node.mesh.policy.forceOnionRouting = true;
    next.node.mesh.policy.defaultHops = proofHops;
  } else {
    next.node.mesh.policy.forceOnionRouting = false;
    delete next.node.mesh.policy.defaultHops;
  }
  if (!next.node.relay || typeof next.node.relay !== "object") next.node.relay = {};
  next.node.relay.listenHost = "127.0.0.1";
  next.node.relay.listenPort = relayPort;
  fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
  fs.writeFileSync(targetConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function shutdown(signal, children) {
  for (const child of children) {
    if (child && !child.killed) child.kill(signal);
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node rez-chat/scripts/dev-mesh.mjs");
    console.log("Runs two local-first rez-chat instances with mesh relay bootstrap.");
    return;
  }

  ensureRootNodeModules();
  const shellPortA = await choosePort({ requested: requestedShellPortA, envVar: "CHAT_PORT_A" });
  const shellPortB = await choosePort({ requested: requestedShellPortB, envVar: "CHAT_PORT_B" });
  const wsPortA = await choosePort({ requested: requestedWsPortA, envVar: "REZ_NODE_WS_PORT_A" });
  const wsPortB = await choosePort({ requested: requestedWsPortB, envVar: "REZ_NODE_WS_PORT_B" });
  const relayPortA = await choosePort({ requested: requestedRelayPortA, envVar: "REZ_RELAY_PORT_A" });
  const relayPortB = await choosePort({ requested: requestedRelayPortB, envVar: "REZ_RELAY_PORT_B" });

  const knownRelays = loadBaseKnownRelays(baseConfigPath);
  const relayInfoRows = loadRelayInfo();
  const effectiveKnownRelays = normalizeKnownRelaysFromRelayInfo(knownRelays, relayInfoRows);
  writeMeshConfig({
    targetConfigPath: configPathA,
    knownRelays: effectiveKnownRelays,
    rotation: 0,
    dataDir: dataDirA,
    relayPort: relayPortA,
    peerRelayPort: relayPortB,
    proofModeEnabled: proofMode,
  });
  writeMeshConfig({
    targetConfigPath: configPathB,
    knownRelays: effectiveKnownRelays,
    rotation: 1,
    dataDir: dataDirB,
    relayPort: relayPortB,
    peerRelayPort: relayPortA,
    proofModeEnabled: proofMode,
  });

  console.log(`[rez-chat:dev-mesh] synced ${effectiveKnownRelays.length} known relays from ${baseConfigPath}`);
  if (relayInfoRows.length > 0) {
    console.log(`[rez-chat:dev-mesh] normalized relay directories from ${RELAY_INFO_PATH}`);
  }
  if (proofMode) {
    console.log(`[rez-chat:dev-mesh] proof mode ON (forceOnionRouting=1, defaultHops=${proofHops}, local peer shortcut disabled)`);
  }
  console.log("[rez-chat:dev-mesh] building rez-chat...");
  await buildUi();
  console.log("[rez-chat:dev-mesh] rez-chat build complete");

  const children = [];
  const childA = startInstance("A", {
    CHAT_ID: "mesh-a",
    CHAT_PORT: String(shellPortA),
    REZ_NODE_WS_PORT: String(wsPortA),
    REZ_NODE_DATA_DIR: dataDirA,
    REZ_CHAT_CONFIG_PATH: configPathA,
    ...(proofMode ? { REZ_TRACE_ONION: "1" } : {}),
  });
  children.push(childA);

  const childB = startInstance("B", {
    CHAT_ID: "mesh-b",
    CHAT_PORT: String(shellPortB),
    REZ_NODE_WS_PORT: String(wsPortB),
    REZ_NODE_DATA_DIR: dataDirB,
    REZ_CHAT_CONFIG_PATH: configPathB,
    ...(proofMode ? { REZ_TRACE_ONION: "1" } : {}),
  });
  children.push(childB);

  const [cfgA, cfgB] = await Promise.all([
    waitForShellConfig(`http://127.0.0.1:${shellPortA}`),
    waitForShellConfig(`http://127.0.0.1:${shellPortB}`),
  ]);

  console.log("");
  console.log("[rez-chat:dev-mesh] started");
  console.log(`[rez-chat:dev-mesh] A UI  http://127.0.0.1:${shellPortA}  ws ${cfgA.wsUrl}`);
  console.log(`[rez-chat:dev-mesh] B UI  http://127.0.0.1:${shellPortB}  ws ${cfgB.wsUrl}`);
  console.log(`[rez-chat:dev-mesh] A config ${configPathA}`);
  console.log(`[rez-chat:dev-mesh] B config ${configPathB}`);
  console.log("");

  process.on("SIGINT", () => shutdown("SIGINT", children));
  process.on("SIGTERM", () => shutdown("SIGTERM", children));
}

main().catch((err) => {
  console.error("[rez-chat:dev-mesh] failed:", err?.message || err);
  process.exit(1);
});
