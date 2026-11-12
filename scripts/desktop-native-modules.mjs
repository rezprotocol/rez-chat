import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PREBUILD_INSTALL = require.resolve("prebuild-install/bin.js");
const BETTER_SQLITE_ROOT = path.dirname(require.resolve("better-sqlite3/package.json"));
const INSTALL_ROOT = path.resolve(BETTER_SQLITE_ROOT, "../..");

export async function prepareElectronNativeModules(env = process.env, opts = {}) {
  if (env.REZ_CHAT_SKIP_ELECTRON_REBUILD === "1") {
    console.log("[desktop:native] skipped Electron native rebuild");
    return;
  }

  console.log("[desktop:native] preparing native modules for Electron");
  await rebuildBetterSqliteForElectron(opts);
}

export async function restoreNodeNativeModules(env = process.env) {
  if (env.REZ_CHAT_RESTORE_NODE_NATIVE === "0") {
    console.log("[desktop:native] skipped Node native restore");
    return;
  }

  console.log("[desktop:native] restoring native modules for Node");
  await runCommand("npm", ["rebuild", "better-sqlite3"], INSTALL_ROOT);
}

async function rebuildBetterSqliteForElectron({ platform, arch } = {}) {
  const target = electronTargetVersion();
  const targetPlatform = platform || process.platform;
  const targetArch = arch || process.arch;
  console.log(
    "[desktop:native] installing better-sqlite3 prebuild for Electron " + target
    + " (" + targetPlatform + "-" + targetArch + ")",
  );
  try {
    await runCommand(process.execPath, [
      PREBUILD_INSTALL,
      "--runtime",
      "electron",
      "--target",
      target,
      "--platform",
      targetPlatform,
      "--arch",
      targetArch,
      "--force",
    ], BETTER_SQLITE_ROOT);
  } catch (err) {
    if (targetPlatform !== process.platform || targetArch !== process.arch) throw err;
    console.warn("[desktop:native] no matching prebuild; compiling better-sqlite3 from source");
    await runCommand("npm", ["rebuild", "better-sqlite3", "--build-from-source"], INSTALL_ROOT, {
      npm_config_runtime: "electron",
      npm_config_target: target,
      npm_config_arch: targetArch,
      npm_config_dist_url: "https://electronjs.org/headers",
      npm_config_build_from_source: "true",
    });
  }
}

function electronTargetVersion() {
  const pkg = JSON.parse(fs.readFileSync(require.resolve("electron/package.json"), "utf8"));
  const version = String(pkg.version || "");
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    throw new Error("Unable to resolve Electron version from rez-chat package.json");
  }
  return version;
}

function runCommand(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const suffix = signal ? " signal " + signal : " code " + String(code);
      reject(new Error(command + " " + args.join(" ") + " failed with" + suffix));
    });
  });
}

async function main() {
  const command = String(process.argv[2] || "").trim();
  // Optional positional overrides — used by cross-platform pack scripts to
  // fetch the prebuild for a target other than the host:
  //   rebuild-electron linux x64
  //   rebuild-electron win32 x64
  // Omit to use the host platform/arch (the desktop:dev flow).
  const platform = process.argv[3] ? String(process.argv[3]).trim() : undefined;
  const arch = process.argv[4] ? String(process.argv[4]).trim() : undefined;
  if (command === "prepare") {
    await prepareElectronNativeModules(process.env, { platform, arch });
    return;
  }
  if (command === "rebuild-electron") {
    await rebuildBetterSqliteForElectron({ platform, arch });
    return;
  }
  if (command === "restore") {
    await restoreNodeNativeModules();
    return;
  }

  console.log("Usage: node scripts/desktop-native-modules.mjs <prepare|rebuild-electron|restore> [platform] [arch]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[desktop:native] failed:", err && err.message ? err.message : err);
    process.exit(1);
  });
}
