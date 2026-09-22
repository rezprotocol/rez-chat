import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { startRezNode } from "@rezprotocol/node";
import { createKeystoreAccount, unlockKeystoreAccount, generateBrowserMnemonic, deriveBrowserAccountRecovery } from "@rezprotocol/sdk/client";
import { bootstrapChatServer } from "../../src/server/index.js";
import { mapUnlockedAccountToRuntimeIdentity } from "../../src/server/bootstrap/unlockedAccountIdentity.js";
import { NativeTestApplication } from "./NativeTestApplication.mjs";

class TestEnvelopeStore {
  #value = null;
  async hasKeystore() { return this.#value !== null; }
  async getKeystoreEnvelope() { return this.#value; }
  async putKeystoreEnvelope(value) { this.#value = value; }
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out: " + label);
}

export async function verifyNativeDelegation(binary, bundle, scratch, portable, portableUrl, diagnostics) {
  const connectionString = process.env.REZ_PG_TEST_URL;
  if (!connectionString) throw new Error("Native delegated acceptance requires REZ_PG_TEST_URL for an isolated test database");
  const pg = await import("pg");
  const Pool = pg.default ? pg.default.Pool : pg.Pool;
  const pool = new Pool({ connectionString });
  const schema = "native_mobile_" + randomBytes(6).toString("hex");
  let home;
  let primary;
  const apps = [];
  try {
    await pool.query("CREATE SCHEMA " + schema);
    const scoped = new URL(connectionString);
    scoped.searchParams.set("options", "-c search_path=" + schema);
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const homeUrl = "ws://127.0.0.1:" + port + "/ws";
    const relayKeyId = portable.runtime.getIdentity().relayKeyId;
    home = await startRezNode({ node: {
      ws: { host: "127.0.0.1", port, path: "/ws" },
      storage: { dataDir: path.join(scratch, "enrollment-home"), backend: "pg", encryptionKeyB64: randomBytes(32).toString("base64"), pg: { connectionString: scoped.href, migrateOnBoot: true } },
      network: { participateInRouting: true, knownRelays: [{ id: relayKeyId, relayKeyId, host: "127.0.0.1", port: portable.relayAddress.port, transport: "tcp", insecure: true, tls: false }] },
      mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5 },
      relay: { listenHost: "127.0.0.1", listenPort: 0 },
      device: { multiDeviceFanout: true },
    } });
    const recovery = await deriveBrowserAccountRecovery(await generateBrowserMnemonic({ words: 24 }));
    const keystoreStore = new TestEnvelopeStore();
    await createKeystoreAccount({ password: "native-primary-password", profileName: "Primary", keystoreStore, identity: recovery.identity });
    const unlocked = await unlockKeystoreAccount({ password: "native-primary-password", keystoreStore });
    unlocked.accountIdentityDhKeyPair = recovery.accountIdentityDhKeyPair;
    const mapped = mapUnlockedAccountToRuntimeIdentity(unlocked);
    primary = await bootstrapChatServer({ nodeDataDir: path.join(scratch, "enrollment-primary"), wsUrl: homeUrl, expectedChatServerIdentity: mapped.identity, deviceKey: mapped.deviceKey });
    await primary.chatServer.start();
    const events = [];
    primary.chatServer.bus.on("deviceLink.updated", (record) => events.push(record));
    const source = await bundle("application", "globalThis.__rezProbeUplink=" + JSON.stringify(portableUrl) + ";globalThis.__rezProbeAccountHome=" + JSON.stringify(homeUrl) + ";");
    const makeApp = (label) => {
      const app = new NativeTestApplication(binary, source, path.join(scratch, label), label, diagnostics);
      apps.push(app);
      return app;
    };
    const peer = makeApp("native-peer-of-linked-phone");
    await peer.call("vault.createAccount", { password: "native-peer-password", profileName: "Native peer" });
    await peer.call("runtime.connect");
    const invitation = await primary.chatServer.bus.call("invite", "create", { kind: "direct", maxUses: 1, creatorDisplayName: "Primary" });
    const accepted = await peer.call("bus:invite.accept", { inviteCode: invitation.inviteCode, acceptorDisplayName: "Native peer" });
    let phone = makeApp("linked-native-phone");
    const ceremony = await primary.chatServer.bus.call("deviceLink", "start", {});
    const enrollment = phone.call("vault.linkDevice", { linkCode: ceremony.linkCode, password: "native-phone-password", profileName: "Linked phone" });
    // Observe rejection immediately even while waiting for the approval event.
    enrollment.catch((error) => diagnostics.push(error.message));
    const pending = await waitFor(() => events.find((event) => event.state === "pending"), "native link approval request");
    await primary.chatServer.bus.call("deviceLink", "approve", { newDeviceId: pending.newDeviceId });
    const summary = await enrollment;
    assert.equal(summary.accountId, primary.ownerAccountId);
    assert.equal(summary.hasAdminRoot, false);
    assert.equal(summary.deviceId, pending.newDeviceId);
    const row = await pool.query("SELECT inbox_id FROM " + schema + ".account_device_registry WHERE device_id=$1", [summary.deviceId]);
    assert.equal(row.rowCount, 1, "Native ceremony did not durably register its device");
    await phone.stop();
    phone = makeApp("linked-native-phone");
    const reopened = await phone.call("vault.unlock", { password: "native-phone-password" });
    assert.equal(reopened.deviceId, summary.deviceId, "Native restart changed the delegated device key");
    const session = await phone.call("runtime.connect");
    assert.notEqual(session.localInboxId, row.rows[0].inbox_id, "Phone reused the enrollment inbox as its portable inbox");
    const listed = await phone.call("vault.listAccounts");
    assert.equal(listed.accounts[0].delegated, true);
    await assert.rejects(phone.call("vault.revealMnemonic", { password: "native-phone-password" }), /primary device/);
    const incomingText = "Message for a linked native phone";
    await peer.call("bus:message.send", { threadId: accepted.threadId, messageId: "native-delegated-incoming", payload: { kind: "rez.chat.message.v1", text: incomingText } });
    const phoneThread = await waitFor(async () => {
      const threads = await phone.call("bus:threads.list");
      for (const thread of threads.threads) {
        const messages = await phone.call("bus:thread.messages.list", { threadId: thread.threadId });
        if (messages.items.some((message) => message.text === incomingText)) return thread.threadId;
      }
      return null;
    }, "linked native phone message receipt");
    await phone.call("bus:message.send", { threadId: phoneThread, messageId: "native-delegated-reply", payload: { kind: "rez.chat.message.v1", text: "Reply from linked native phone" } });
    await waitFor(async () => {
      const messages = await peer.call("bus:thread.messages.list", { threadId: accepted.threadId });
      return messages.items.some((message) => message.text === "Reply from linked native phone");
    }, "linked native phone reply");
    await waitFor(async () => {
      const messages = await phone.call("bus:thread.messages.list", { threadId: phoneThread });
      return messages.items.some((message) => message.messageId === "native-delegated-reply" && message.status === "delivered");
    }, "linked native phone verified reply acknowledgement");
    const documentBytes = Buffer.from("A document for every active device, including the portable iPhone.");
    const document = await peer.call("bus:file.send", { threadId: accepted.threadId, fileDataB64: documentBytes.toString("base64"), fileName: "shared-document.txt", mimeType: "text/plain" });
    await waitFor(async () => {
      const file = await phone.call("bus:file.get", { fileHashHex: document.fileHashHex });
      return file.fileDataB64 === documentBytes.toString("base64");
    }, "attachment reaches the linked native phone through the verified device roster");
    const replyDocument = await phone.call("bus:file.send", { threadId: phoneThread, fileDataB64: documentBytes.toString("base64"), fileName: "phone-reply.txt", mimeType: "text/plain" });
    await waitFor(async () => {
      const messages = await peer.call("bus:thread.messages.list", { threadId: accepted.threadId });
      return messages.items.some((message) => message.payload && message.payload.fileName === "phone-reply.txt");
    }, "linked native phone sends an attachment back to its contact");
    assert.equal(replyDocument.fileHashHex, document.fileHashHex);
    const latePeer = makeApp("native-peer-added-after-activation");
    const lateIdentity = await latePeer.call("vault.createAccount", { password: "native-late-peer-password", profileName: "New contact" });
    await latePeer.call("runtime.connect");
    const laterInvite = await primary.chatServer.bus.call("invite", "create", { kind: "direct", maxUses: 1, creatorDisplayName: "Primary" });
    const laterAccepted = await latePeer.call("bus:invite.accept", { inviteCode: laterInvite.inviteCode, acceptorDisplayName: "New contact" });
    const siblings = await primary.chatServer.bus.runtime.sdk.listSiblingDeviceInboxes();
    assert(siblings.some((device) => device.deviceId === summary.deviceId && device.inboxId === session.localInboxId), "Sibling synchronization must target the portable phone inbox");
    await latePeer.call("bus:message.send", { threadId: laterAccepted.threadId, messageId: "native-new-contact", payload: { kind: "rez.chat.message.v1", text: "New contact after phone activation" } });
    await waitFor(async () => {
      for (const threadId of await primary.chatServer.bus.stores.threadStore.listThreadIds()) {
        const page = await primary.chatServer.bus.stores.threadStore.listMessages({ threadId });
        if (page.items.some((message) => message.messageId === "native-new-contact")) return true;
      }
      return false;
    }, "primary receives immediate new-contact message");
    await waitFor(async () => {
      const threads = await phone.call("bus:threads.list");
      return threads.threads.some((thread) => thread.peerAccountId === lateIdentity.accountId);
    }, "new contact relationship synchronizes to the linked phone");
    await waitFor(async () => {
      const threads = await phone.call("bus:threads.list");
      for (const thread of threads.threads) {
        const messages = await phone.call("bus:thread.messages.list", { threadId: thread.threadId });
        if (messages.items.some((message) => message.text === "New contact after phone activation")) return true;
      }
      return false;
    }, "new contact reaches an already-activated native phone");
    await latePeer.call("vault.lock");
    await peer.call("vault.lock");
    await phone.call("vault.lock");
    await phone.stop();
    phone = makeApp("linked-native-phone");
    await phone.call("vault.unlock", { password: "native-phone-password" });
    // No account-home connection can succeed after this point. The native
    // steady-state boot must reconstruct exclusively from its durable state.
    await primary.chatServer.stop(); primary = null;
    await home.stop(); home = null;
    const restarted = await phone.call("runtime.connect");
    assert.equal((await phone.call("bus:file.get", { fileHashHex: document.fileHashHex })).fileDataB64, documentBytes.toString("base64"), "Delegated attachment survives restart without the account home");
    assert.equal(restarted.localInboxId, session.localInboxId);
    await phone.call("vault.lock");
    console.log("PASS: native delegated ceremony, durable custody, two-way messages, new contacts, process restart and claimant reboot with the enrollment home offline");
  } catch (error) {
    throw new Error(error.message + "\n" + diagnostics.slice(-30).join("\n"), { cause: error });
  } finally {
    for (const app of apps) await app.stop();
    if (primary) await primary.chatServer.stop();
    if (home) await home.stop();
    await pool.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await pool.end();
  }
}
