/**
 * Fetches the official Node.js binary for the Tauri sidecar (externalBin).
 *
 * Tauri's externalBin convention wants per-target-triple names:
 *   src-tauri/binaries/node-aarch64-apple-darwin
 *   src-tauri/binaries/node-x86_64-apple-darwin
 *   src-tauri/binaries/node-x86_64-pc-windows-msvc.exe
 *   src-tauri/binaries/node-x86_64-unknown-linux-gnu
 *
 * Usage:
 *   node scripts/fetch-sidecar-node.mjs              # host triple
 *   node scripts/fetch-sidecar-node.mjs <triple>     # explicit triple
 *
 * Downloads from nodejs.org/dist, verifies against SHASUMS256.txt, extracts
 * just the node binary, and names it for the triple. Pinned to the same
 * Node line CI uses (see .github/workflows/desktop-build.yml).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "22.15.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(CHAT_ROOT, "src-tauri", "binaries");

const TRIPLE_TO_DIST = {
  "aarch64-apple-darwin": { dist: `node-v${NODE_VERSION}-darwin-arm64`, ext: "tar.gz", binPath: "bin/node" },
  "x86_64-apple-darwin": { dist: `node-v${NODE_VERSION}-darwin-x64`, ext: "tar.gz", binPath: "bin/node" },
  "x86_64-unknown-linux-gnu": { dist: `node-v${NODE_VERSION}-linux-x64`, ext: "tar.gz", binPath: "bin/node" },
  "aarch64-unknown-linux-gnu": { dist: `node-v${NODE_VERSION}-linux-arm64`, ext: "tar.gz", binPath: "bin/node" },
  "x86_64-pc-windows-msvc": { dist: `node-v${NODE_VERSION}-win-x64`, ext: "zip", binPath: "node.exe" },
};

function hostTriple() {
  const arch = os.arch();
  const platform = os.platform();
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  throw new Error("Unsupported host platform: " + platform);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("download failed " + res.status + ": " + url);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const triple = process.argv[2] || hostTriple();
  const spec = TRIPLE_TO_DIST[triple];
  if (!spec) {
    throw new Error("Unknown target triple '" + triple + "'. Known: " + Object.keys(TRIPLE_TO_DIST).join(", "));
  }
  const isWindows = triple.includes("windows");
  const outName = "node-" + triple + (isWindows ? ".exe" : "");
  const outPath = path.join(BIN_DIR, outName);
  if (fs.existsSync(outPath)) {
    console.log("[fetch-sidecar-node] already present: " + outPath);
    return;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const archiveName = spec.dist + "." + spec.ext;
  const baseUrl = "https://nodejs.org/dist/v" + NODE_VERSION + "/";
  console.log("[fetch-sidecar-node] downloading " + baseUrl + archiveName);
  const [archive, shasums] = await Promise.all([
    download(baseUrl + archiveName),
    download(baseUrl + "SHASUMS256.txt"),
  ]);

  const expectedLine = shasums
    .toString("utf8")
    .split("\n")
    .find((line) => line.trim().endsWith(archiveName));
  if (!expectedLine) throw new Error("SHASUMS256.txt has no entry for " + archiveName);
  const expected = expectedLine.trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error("SHA-256 mismatch for " + archiveName + ": expected " + expected + ", got " + actual);
  }
  console.log("[fetch-sidecar-node] checksum verified (" + expected.slice(0, 12) + "…)");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rez-node-fetch-"));
  const archivePath = path.join(workDir, archiveName);
  fs.writeFileSync(archivePath, archive);
  if (spec.ext === "tar.gz") {
    execFileSync("tar", ["-xzf", archivePath, "-C", workDir]);
  } else {
    // Windows zip: PowerShell on Windows runners, unzip elsewhere.
    if (os.platform() === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command",
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${workDir}"`]);
    } else {
      execFileSync("unzip", ["-q", archivePath, "-d", workDir]);
    }
  }
  const extractedBin = path.join(workDir, spec.dist, spec.binPath);
  fs.copyFileSync(extractedBin, outPath);
  if (!isWindows) fs.chmodSync(outPath, 0o755);
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log("[fetch-sidecar-node] wrote " + outPath);
}

main().catch((err) => {
  console.error("[fetch-sidecar-node] " + (err && err.message ? err.message : err));
  process.exit(1);
});
