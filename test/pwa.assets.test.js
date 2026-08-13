import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("production build emits an installable manifest, service worker, and canonical icons", async () => {
  const out = path.join(root, "artifacts", "rez-chat");
  const manifest = JSON.parse(await readFile(path.join(out, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.deepEqual(manifest.icons.map((icon) => icon.src), [
    "/icons/rez-chat-256.png",
    "/icons/rez-chat-1024.png",
  ]);
  await access(path.join(out, "sw.js"));
  await access(path.join(out, "icons", "rez-chat-256.png"));
  await access(path.join(out, "icons", "rez-chat-1024.png"));
});

test("service worker keeps live protocol endpoints network-owned", async () => {
  const source = await readFile(path.join(root, "public", "sw.js"), "utf8");
  for (const pathName of ["/ws", "/config", "/health", "/ready"]) {
    assert.match(source, new RegExp("\\\"" + pathName + "\\\""));
  }
});
