import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runOrThrow(cmd, args, { cwd, timeoutMs = 30_000 }) {
  const out = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  if (out.status !== 0) {
    const detail = `${out.stdout || ""}\n${out.stderr || ""}`.trim();
    const timeoutHint = out.error?.code === "ETIMEDOUT" ? `\n(command timed out after ${timeoutMs}ms)` : "";
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}${timeoutHint}\n${detail}`);
  }
  return out.stdout || "";
}

function npmPack(workspaceDir, packDestDir, cacheDir) {
  const stdout = runOrThrow(
    "npm",
    ["pack", "--silent", "--pack-destination", packDestDir, "--cache", cacheDir],
    { cwd: workspaceDir },
  );
  const tarballName = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!tarballName) {
    throw new Error(`npm pack returned no tarball name for ${workspaceDir}`);
  }
  return path.join(packDestDir, tarballName);
}

test("SDK tarball installs into isolated app without workspace links", { timeout: 120_000 }, async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rez-sdk-portability-"));
  const packDir = path.join(tmpRoot, "packs");
  const sampleDir = path.join(tmpRoot, "sample-app");
  const cacheDir = path.join(tmpRoot, ".npm-cache");

  try {
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(sampleDir, { recursive: true });
    await fs.mkdir(cacheDir, { recursive: true });

    const workspaceOrder = [
      "rez-core",
      "rez-node",
      "rez-sdk",
    ];
    const tgzs = [];
    for (const workspace of workspaceOrder) {
      const workspaceDir = path.join(REPO_ROOT, workspace);
      await fs.access(workspaceDir);
      tgzs.push(npmPack(workspaceDir, packDir, cacheDir));
    }

    await fs.writeFile(
      path.join(sampleDir, "package.json"),
      JSON.stringify({
        name: "rez-sdk-portability-sample",
        private: true,
        type: "module",
      }, null, 2),
      "utf8",
    );

    try {
      runOrThrow(
        "npm",
        ["install", "--no-audit", "--no-fund", "--cache", cacheDir, ...tgzs],
        { cwd: sampleDir, timeoutMs: 45_000 },
      );
    } catch (err) {
      const msg = String(err?.message || "");
      if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network|fetch|timed out/i.test(msg)) {
        t.skip("npm install unavailable in this environment");
        return;
      }
      throw err;
    }

    const sdkInstallPath = path.join(sampleDir, "node_modules", "@rezprotocol", "sdk");
    const stats = await fs.lstat(sdkInstallPath);
    assert.equal(stats.isSymbolicLink(), false, "sdk install must not be a workspace symlink");

    const sdkPkgRaw = await fs.readFile(path.join(sdkInstallPath, "package.json"), "utf8");
    const sdkPkg = JSON.parse(sdkPkgRaw);
    const depRanges = Object.values(sdkPkg.dependencies || {}).map((value) => String(value));
    for (const range of depRanges) {
      assert.equal(range.startsWith("file:"), false, `sdk tarball dependency must not use file: range (${range})`);
      assert.equal(range === "workspace:*", false, `sdk tarball dependency must not use workspace:* (${range})`);
    }

    const verifyScript = [
      'import { UplinkPoolClient } from "@rezprotocol/sdk/client";',
      'const sdk = new UplinkPoolClient({ uplinks: ["ws://127.0.0.1:65535/ws"], warmSpareCount: 1, accountId: "rez:acct:test", accountIdentityPublicKeyB64: "dGVzdA==", accountIdentityPrivateKeyB64: "dGVzdA==" });',
      'if (typeof sdk.connect !== "function") throw new Error("missing connect()");',
      'if (typeof sdk.sendRequest !== "function") throw new Error("missing sendRequest()");',
      'if (typeof sdk.getHelloInfo !== "function") throw new Error("missing getHelloInfo()");',
      "await sdk.close();",
      'console.log("sdk-portability-ok");',
    ].join("\n");
    await fs.writeFile(path.join(sampleDir, "verify.mjs"), verifyScript, "utf8");

    const verifyOut = runOrThrow("node", ["verify.mjs"], { cwd: sampleDir });
    assert.match(verifyOut, /sdk-portability-ok/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});
