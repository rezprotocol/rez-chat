import { launchDesktopProfile, resolveShellKind } from "./desktop-dev-profile.mjs";
import { prepareElectronNativeModules, restoreNodeNativeModules } from "./desktop-native-modules.mjs";

// The Electron-ABI better-sqlite3 swap is poison for the Tauri path: the
// sidecar is plain Node and needs the plain-Node prebuild. Mirror the guard
// in desktop-dev-profile.mjs's main() so `tauri:dev:three` never clobbers it.
const tauriShell = resolveShellKind({}) === "tauri";

const children = [];
let shuttingDown = false;
let finishing = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of children) {
    if (entry.child && !entry.child.killed) {
      entry.child.kill(signal);
    }
  }
}

function start(name) {
  const entry = launchDesktopProfile(name, {
    prefix: true,
    onExit: ({ profile, code, signal }) => {
      markExited(profile.name);
      console.log("[desktop:" + profile.name + "] exited code=" + String(code) + " signal=" + String(signal || ""));
      if (!shuttingDown) {
        shutdown("SIGTERM");
        process.exitCode = code == null ? 1 : code;
      }
      finishWhenDone();
    },
  });
  entry.exited = false;
  children.push(entry);
  console.log("[desktop:" + entry.profile.name + "] userData " + entry.profile.userDataDir);
  console.log("[desktop:" + entry.profile.name + "] shell http://127.0.0.1:" + entry.profile.desktopPort + "/");
  console.log("[desktop:" + entry.profile.name + "] node ws://127.0.0.1:" + entry.profile.nodeWsPort + "/ws");
  console.log("[desktop:" + entry.profile.name + "] window " + entry.profile.windowWidth + "x" + entry.profile.windowHeight + "+" + entry.profile.windowX + "+" + entry.profile.windowY);
}

function markExited(profileName) {
  for (const entry of children) {
    if (entry.profile.name === profileName) {
      entry.exited = true;
    }
  }
}

function allExited() {
  if (children.length === 0) return false;
  for (const entry of children) {
    if (!entry.exited) return false;
  }
  return true;
}

function finishWhenDone() {
  if (!allExited() || finishing) return;
  finishing = true;
  if (tauriShell) {
    process.exit(process.exitCode == null ? 0 : process.exitCode);
    return;
  }
  restoreNodeNativeModules()
    .catch((err) => {
      console.error("[desktop:native] restore failed:", err && err.message ? err.message : err);
      if (process.exitCode == null || process.exitCode === 0) process.exitCode = 1;
    })
    .finally(() => {
      process.exit(process.exitCode == null ? 0 : process.exitCode);
    });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/desktop-dev-three.mjs");
    return;
  }

  if (!tauriShell) {
    await prepareElectronNativeModules();
  }
  start("alice");
  start("bob");
  start("carol");

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[desktop:three] failed:", err && err.message ? err.message : err);
  shutdown("SIGTERM");
  process.exit(1);
});
