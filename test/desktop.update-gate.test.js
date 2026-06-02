// The load-phase update gate: checkAndApplyDuringLoad() must apply an update
// when one exists (so a stale client updates before touching reznet), and must
// NEVER block startup when the check fails, times out, or finds nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { DesktopUpdater } from "../electron/runtime/DesktopUpdater.mjs";

class FakeUpdater extends EventEmitter {
  constructor(behavior) {
    super();
    this.behavior = behavior;
    this.quitCalled = 0;
    this.autoDownload = null;
    this.autoInstallOnAppQuit = null;
    this.logger = null;
  }
  async checkForUpdates() {
    queueMicrotask(() => {
      if (this.behavior === "not-available") {
        this.emit("update-not-available", { version: "0.3.1" });
      } else if (this.behavior === "downloaded") {
        this.emit("download-progress", { percent: 42 });
        this.emit("update-downloaded", { version: "0.3.1" });
      } else if (this.behavior === "error") {
        this.emit("error", new Error("network down"));
      }
      // "hang": emit nothing → exercises the timeout path
    });
    return {};
  }
  quitAndInstall() { this.quitCalled += 1; }
}

function makeUpdater(behavior, { packaged = true } = {}) {
  const fake = new FakeUpdater(behavior);
  const updater = new DesktopUpdater({
    app: { isPackaged: packaged },
    getWindow: () => null,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    updater: fake,
  });
  return { updater, fake };
}

test("no update available → { applying: false }, startup continues", async () => {
  const { updater } = makeUpdater("not-available");
  const result = await updater.checkAndApplyDuringLoad();
  assert.deepEqual(result, { applying: false });
});

test("update downloaded → { applying: true } and quitAndInstall is invoked", async () => {
  const { updater, fake } = makeUpdater("downloaded");
  const statuses = [];
  const result = await updater.checkAndApplyDuringLoad({ setStatus: (m) => statuses.push(m) });
  assert.deepEqual(result, { applying: true });
  await new Promise((r) => setTimeout(r, 320)); // quitAndInstall fires after a 250ms paint delay
  assert.equal(fake.quitCalled, 1, "the app relaunches into the new version");
  assert.ok(statuses.some((m) => /Installing update/.test(m)), "splash shows install state");
});

test("a failed update check NEVER blocks startup → { applying: false }", async () => {
  const { updater } = makeUpdater("error");
  const result = await updater.checkAndApplyDuringLoad();
  assert.deepEqual(result, { applying: false });
});

test("a hung/slow check times out and continues offline → { applying: false }", async () => {
  const { updater } = makeUpdater("hang");
  const start = Date.now();
  const result = await updater.checkAndApplyDuringLoad({ timeoutMs: 150 });
  assert.deepEqual(result, { applying: false });
  assert.ok(Date.now() - start >= 140, "it waited for the timeout, then continued");
});

test("dev mode (unpackaged) skips the gate immediately", async () => {
  const { updater } = makeUpdater("downloaded", { packaged: false });
  const result = await updater.checkAndApplyDuringLoad();
  assert.deepEqual(result, { applying: false });
});
