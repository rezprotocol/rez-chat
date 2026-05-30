import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(__dirname, "..", "artifacts", "rez-chat-desktop");

const VALID_PLATFORMS = new Set(["mac", "linux", "win", "dir"]);

const rawPlatform = (process.argv[2] || "").toLowerCase();
if (!rawPlatform) {
  console.error("prepare-pack: missing platform argument (mac|linux|win|dir)");
  process.exit(1);
}
if (!VALID_PLATFORMS.has(rawPlatform)) {
  console.error(`prepare-pack: unknown platform "${rawPlatform}" (expected mac|linux|win|dir)`);
  process.exit(1);
}

// For --dir builds, electron-builder writes the unpacked tree for the host
// platform only. Resolve "dir" to the concrete platform so we clean the
// right subtree and leave other platforms' artifacts intact.
function resolveDirPlatform() {
  const p = os.platform();
  if (p === "darwin") return "mac";
  if (p === "linux") return "linux";
  if (p === "win32") return "win";
  console.error(`prepare-pack: unsupported host platform "${p}" for --dir build`);
  process.exit(1);
  return null;
}

const platform = rawPlatform === "dir" ? resolveDirPlatform() : rawPlatform;

// Per-platform cleanup spec. `dirs` is a list of subdirectory names to remove
// recursively. `filePatterns` is a list of RegExps matched against entry names
// (not paths) at the top level of outputDir.
const PLATFORM_CLEANUP = {
  mac: {
    dirs: ["mac", "mac-arm64"],
    filePatterns: [
      /\.dmg$/i,
      /\.dmg\.blockmap$/i,
      /-mac\.zip$/i,
      /-mac\.zip\.blockmap$/i,
      /^latest-mac\.yml$/i,
    ],
  },
  linux: {
    dirs: ["linux-unpacked", "linux-arm64-unpacked"],
    filePatterns: [
      /\.AppImage$/i,
      /\.AppImage\.blockmap$/i,
      /\.snap$/i,
      /\.deb$/i,
      /\.rpm$/i,
      /-linux\.zip$/i,
      /-linux\.zip\.blockmap$/i,
      /^latest-linux\.yml$/i,
    ],
  },
  win: {
    dirs: ["win-unpacked", "win-ia32-unpacked", "win-arm64-unpacked"],
    filePatterns: [
      /\.exe$/i,
      /\.exe\.blockmap$/i,
      /-win\.zip$/i,
      /-win\.zip\.blockmap$/i,
      /^latest\.yml$/i,
    ],
  },
};

const spec = PLATFORM_CLEANUP[platform];

if (!fs.existsSync(outputDir)) {
  console.log(`prepare-pack: ${outputDir} does not exist — nothing to clean for ${platform}`);
  process.exit(0);
}

const entries = fs.readdirSync(outputDir, { withFileTypes: true });
const removed = [];
for (const entry of entries) {
  const fullPath = path.join(outputDir, entry.name);
  if (entry.isDirectory()) {
    if (spec.dirs.includes(entry.name)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(entry.name + "/");
    }
    continue;
  }
  if (spec.filePatterns.some((re) => re.test(entry.name))) {
    fs.rmSync(fullPath, { force: true });
    removed.push(entry.name);
  }
}

if (removed.length === 0) {
  console.log(`prepare-pack: no existing ${platform} artifacts to clean in ${outputDir}`);
} else {
  console.log(`prepare-pack: cleaned ${removed.length} ${platform} artifact(s) from ${outputDir}`);
  for (const name of removed) console.log(`  - ${name}`);
}
