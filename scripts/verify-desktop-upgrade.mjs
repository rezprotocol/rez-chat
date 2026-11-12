import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Invoke with EACH artifact's bundled Node. This exercises that artifact's
// actual native SQLite binding, vault, records, storage and bootstrap code.
// Only synthetic password-vault fixtures are used; OS keychain acceptance
// remains a separate manual release check. Never print keys or recovery words.
const [phase, resources, profile] = process.argv.slice(2);
assert.ok(["seed", "check"].includes(phase) && resources && profile,
  "Usage: verify-desktop-upgrade.mjs <seed|check> <bundle-resources> <isolated-profile>");
if (phase === "seed") assert.equal(fs.existsSync(profile), false, "Seed requires a new isolated profile");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const load = (relative) => import(pathToFileURL(path.join(resources, relative)));
const { DesktopVaultService } = await load("src/desktop/runtime/DesktopVaultService.js");
const { bootstrapChatServer } = await load("src/server/bootstrap/bootstrapChatServer.js");
const { FsStorageProvider } = await load("node_modules/@rezprotocol/node/src/index.js");
const { ThreadStoreService } = await load("src/server/storage/ChatThreadStore.js");
const { ChatMessage } = await load("src/records/domain/ChatMessage.js");
const password = "synthetic private artifact upgrade fixture";
const messageText = "Encrypted message retained from old installer";
const vaultIdPath = path.join(profile, "upgrade-vault-account.txt");
const accountIdPath = path.join(profile, "upgrade-network-account.txt");
const deviceIdPath = path.join(profile, "upgrade-device.txt");
const nodeDataDir = path.join(profile, "node-data");
const chatDir = path.join(nodeDataDir, "chat-server");
const publicKv = new FsStorageProvider({ rootDir: chatDir }).getKeyValueStore(null);
const vault = new DesktopVaultService({ dbPath: path.join(profile, "desktop-vault.sqlite") }).open();

function assertAbsentFromFiles(directory, value) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) assertAbsentFromFiles(file, value);
    else assert.equal(fs.readFileSync(file).includes(Buffer.from(value)), false,
      "Sensitive plaintext must not remain in chat-server files");
  }
}

try {
  if (phase === "seed") {
    const account = await vault.createAccount({ profileName: "Old release upgrade fixture", password });
    // Old releases used a vault-row ID distinct from the network account ID.
    fs.writeFileSync(vaultIdPath, account.accountId);
  } else {
    const accountId = fs.readFileSync(vaultIdPath, "utf8");
    const before = await publicKv.getStrict("chat-server:identity:v1");
    assert.ok(before, "Upgrade requires the original identity");
    await assert.rejects(() => vault.unlock({ accountId, password: "wrong password" }));
    assert.deepEqual(await publicKv.getStrict("chat-server:identity:v1"), before,
      "Failed unlock must preserve the legacy recovery evidence");
    await vault.unlock({ accountId, password });
  }
  const expected = vault.getChatServerIdentity();
  const runtime = await bootstrapChatServer({ nodeDataDir, wsUrl: "ws://127.0.0.1:1/ws", expectedChatServerIdentity: expected });
  try {
    const store = new ThreadStoreService({ storageProvider: runtime.storageProvider, ownerAccountId: expected.accountId });
    if (phase === "seed") {
      await store.ensureThread({ threadId: "th:artifact-upgrade", threadType: "direct", peerAccountId: "rez:acct:synthetic-peer", peerInboxId: "inbox:synthetic-peer" });
      await store.upsertMessage(new ChatMessage({ threadId: "th:artifact-upgrade", messageId: "msg:legacy", senderAccountId: expected.accountId, text: messageText, packetB64: "YQ==", createdAtMs: 1, status: "delivered" }));
      const row = await publicKv.getStrict("chat-server:identity:v1");
      assert.equal(row.privateKeyB64, expected.privateKeyB64,
        "Old artifact must reproduce legacy inline custody");
      fs.writeFileSync(accountIdPath, runtime.identity.accountId);
      fs.writeFileSync(deviceIdPath, runtime.identity.deviceId);
    } else {
      assert.equal(runtime.identity.accountId, fs.readFileSync(accountIdPath, "utf8"));
      assert.equal(runtime.identity.deviceId, fs.readFileSync(deviceIdPath, "utf8"));
      const messages = await store.listMessages({ threadId: "th:artifact-upgrade" });
      assert.equal(messages.items.length, 1);
      assert.equal(messages.items[0].text, messageText);
      assert.equal(messages.items[0].status, "delivered");
      const row = await publicKv.getStrict("chat-server:identity:v1");
      assert.equal(row.privateKeyB64, "");
      assert.equal(row.rootKeyCustody, "vault");
      assertAbsentFromFiles(chatDir, expected.privateKeyB64);
    }
    assertAbsentFromFiles(chatDir, messageText);
  } finally {
    await runtime.chatServer.stop();
  }
  console.log("PASS artifact " + phase + ": identity, device and encrypted message preserved; no private material logged");
} finally {
  vault.close();
}
