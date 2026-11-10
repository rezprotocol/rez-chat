import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultStorageProvider } from "@rezprotocol/sdk/client";
import { ChatServerApp } from "../src/server/app/ChatServerApp.js";
import { FileGetParams } from "../src/records/index.js";
import { makeSealDispatch } from "./support/sealDispatchDouble.js";

function gate() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const connection = gate(); const catchup = gate();
  const sdk = {
    ...makeSealDispatch(),
    close: async () => {},
    getIdentity: () => ({ localInboxId: "inbox:background" }),
    connectivity: { onReconnected: () => () => {} },
    subscriptions: { onMailboxDeposited: () => () => {}, onEvent: () => () => {} },
    node: { status: async () => ({}) },
    mailbox: { list: () => catchup.promise, fetch: async () => { throw new Error("empty list fixture"); }, ack: async () => {} },
  };
  const app = new ChatServerApp({
    identity: { accountId: "acct:background", deviceId: "device:background", publicKeyB64: "p", privateKeyB64: "s" },
    ownerAccountId: "acct:background", uplinks: ["ws://fixture"], sdk,
    logger: { log() {}, warn() {}, info() {}, error() {} },
    storageProvider: createDefaultStorageProvider(),
    inboxClaimant: { inboxId: "inbox:background", claimStore: {} },
  });
  app.bus.services.runtime.connect = () => connection.promise;
  return { app, sdk, connection, catchup };
}

async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("startup waited for background sync")), 1000); })]); }
  finally { clearTimeout(timer); }
}

test("local services become usable after binding while inbox readiness stays pending", async (t) => {
  const { app, connection, catchup } = fixture();
  t.after(async () => { connection.resolve(); catchup.resolve({ items: [] }); await app.stop(); });
  let ready = false; let synced = false;
  app.on("server.ready", () => { ready = true; });
  app.on("inbox.caughtup", () => { synced = true; });
  const started = app.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false, "a pending mandatory bind still blocks startup");
  connection.resolve();
  await within(started);
  assert.equal(ready, true);
  assert.equal(synced, false, "local availability never claims inbox completion");
  const result = await app.bus.services.fileTransfer.getFile(new FileGetParams({ fileHashHex: "0".repeat(64) }));
  assert.equal(result.fileDataB64, "", "local consumer is active before catch-up finishes");
  const caughtUp = new Promise((resolve) => app.on("inbox.caughtup", resolve));
  catchup.resolve({ items: [] }); await within(caughtUp);
  assert.equal(synced, true);
});

test("terminal binding and static catch-up wiring failures still reject startup", async (t) => {
  const refused = fixture();
  t.after(() => refused.app.stop());
  const error = new Error("home refused");
  refused.connection.reject(error);
  await assert.rejects(refused.app.start(), /home refused/);
  const broken = fixture();
  t.after(() => broken.app.stop());
  broken.sdk.mailbox = null; broken.connection.resolve();
  await assert.rejects(broken.app.start(), /requires sdk.mailbox/);
});

test("background failure is visible and cannot emit a successful sync signal", async (t) => {
  const { app, connection, catchup } = fixture();
  t.after(() => app.stop()); connection.resolve();
  let synced = false; app.on("inbox.caughtup", () => { synced = true; });
  const notice = new Promise((resolve) => app.on("app.error", (event) => { if (event.source === "ChatServerApp") resolve(event); }));
  await within(app.start());
  catchup.reject(new Error("storage unavailable"));
  const error = await within(notice);
  assert.match(error.message, /Inbox sync failed/);
  assert.equal(synced, false);
});

test("a drain finishing after shutdown cannot announce readiness", async () => {
  const { app, connection, catchup } = fixture(); connection.resolve();
  let synced = false; app.on("inbox.caughtup", () => { synced = true; });
  await within(app.start()); await app.stop();
  catchup.resolve({ items: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(synced, false);
});
