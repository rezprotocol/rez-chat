import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CHAT_ROOT, "..");
const ARTIFACT_UI_ROOT = path.resolve(REPO_ROOT, "artifacts", "rez-chat");

const shellPortA = Number.parseInt(process.env.CHAT_PORT_A || "3000", 10);
const shellPortB = Number.parseInt(process.env.CHAT_PORT_B || "3001", 10);
const wsPortA = Number.parseInt(process.env.REZ_NODE_WS_PORT_A || "8787", 10);
const wsPortB = Number.parseInt(process.env.REZ_NODE_WS_PORT_B || "8788", 10);
const dataDirA = process.env.REZ_NODE_DATA_DIR_A || path.join(CHAT_ROOT, ".local", "dev-two-dual", "a-data");
const dataDirB = process.env.REZ_NODE_DATA_DIR_B || path.join(CHAT_ROOT, ".local", "dev-two-dual", "b-data");
const configPathA = process.env.REZ_CHAT_CONFIG_PATH_A || path.join(CHAT_ROOT, ".local", "dev-two-dual", "a.config.json");
const configPathB = process.env.REZ_CHAT_CONFIG_PATH_B || path.join(CHAT_ROOT, ".local", "dev-two-dual", "b.config.json");

function startInstance(label, env) {
  const child = spawn("npm", ["--prefix", CHAT_ROOT, "run", "start"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}

function shutdown(signal, childA, childB) {
  if (childA && !childA.killed) childA.kill(signal);
  if (childB && !childB.killed) childB.kill(signal);
}

async function buildUi() {
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["-w", "rez-chat", "run", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.once(`error`, reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rez-chat build failed with exit code ${code}`));
    });
  });
  if (!fs.existsSync(ARTIFACT_UI_ROOT)) {
    throw new Error(`rez-chat build did not produce ${ARTIFACT_UI_ROOT}`);
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node rez-chat/scripts/dev-two.mjs");
    return;
  }
  console.log("[rez-chat:dev-two] building rez-chat...");
  await buildUi();
  console.log("[rez-chat:dev-two] rez-chat build complete");

  const childA = startInstance("A", {
    CHAT_ID: "A",
    CHAT_PORT: String(shellPortA),
    REZ_NODE_WS_PORT: String(wsPortA),
    REZ_NODE_DATA_DIR: dataDirA,
    REZ_CHAT_CONFIG_PATH: configPathA,
  });

  const childB = startInstance("B", {
    CHAT_ID: "B",
    CHAT_PORT: String(shellPortB),
    REZ_NODE_WS_PORT: String(wsPortB),
    REZ_NODE_DATA_DIR: dataDirB,
    REZ_CHAT_CONFIG_PATH: configPathB,
  });

  console.log("[rez-chat:dev-two] started");
  console.log(`[rez-chat:dev-two] A UI http://127.0.0.1:${shellPortA}/ | /config http://127.0.0.1:${shellPortA}/config | ws ws://127.0.0.1:${wsPortA}/ws | data ${dataDirA}`);
  console.log(`[rez-chat:dev-two] B UI http://127.0.0.1:${shellPortB}/ | /config http://127.0.0.1:${shellPortB}/config | ws ws://127.0.0.1:${wsPortB}/ws | data ${dataDirB}`);

  process.on("SIGINT", () => shutdown("SIGINT", childA, childB));
  process.on("SIGTERM", () => shutdown("SIGTERM", childA, childB));
}

main().catch((err) => {
  console.error("[rez-chat:dev-two] failed:", err?.message || err);
  process.exit(1);
});
