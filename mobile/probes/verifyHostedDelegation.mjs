import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes } from "node:crypto";
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

export async function verifyHostedDelegation(binary, source, scratch, config) {
  const password = randomBytes(24).toString("base64url");
  const recovery = await deriveBrowserAccountRecovery(await generateBrowserMnemonic({ words: 24 }));
  const keystoreStore = new TestEnvelopeStore();
  await createKeystoreAccount({ password, profileName: "Live enrollment test", keystoreStore, identity: recovery.identity });
  const unlocked = await unlockKeystoreAccount({ password, keystoreStore });
  unlocked.accountIdentityDhKeyPair = recovery.accountIdentityDhKeyPair;
  const mapped = mapUnlockedAccountToRuntimeIdentity(unlocked);
  const primary = await bootstrapChatServer({ nodeDataDir: path.join(scratch, "primary"), wsUrl: config.accountHomeUplinks[0], expectedChatServerIdentity: mapped.identity, deviceKey: mapped.deviceKey });
  const diagnostics = [];
  const apps = [];
  const open = (name) => {
    const app = new NativeTestApplication(binary, source, path.join(scratch, name), name, diagnostics);
    apps.push(app);
    return app;
  };
  async function waitFor(read, label) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Timed out: " + label + "\n" + diagnostics.slice(-12).join("\n"));
  }
  try {
    await primary.chatServer.start();
    const events = [];
    primary.chatServer.bus.on("deviceLink.updated", (event) => events.push(event));
    const peer = open("delegated-peer");
    await peer.call("vault.createAccount", { profileName: "Live enrollment peer", password });
    await peer.call("runtime.connect");
    const invitation = await primary.chatServer.bus.call("invite", "create", { kind: "direct", maxUses: 1, creatorDisplayName: "Live enrollment test" });
    const accepted = await peer.call("bus:invite.accept", { inviteCode: invitation.inviteCode, acceptorDisplayName: "Live enrollment peer" });
    let phone = open("delegated-phone");
    const ceremony = await primary.chatServer.bus.call("deviceLink", "start", {});
    const enrolling = phone.call("vault.linkDevice", { linkCode: ceremony.linkCode, password, profileName: "Live linked phone" });
    enrolling.catch((error) => diagnostics.push(error.message));
    const pending = await waitFor(() => events.find((event) => event.state === "pending"), "live primary approval request");
    await primary.chatServer.bus.call("deviceLink", "approve", { newDeviceId: pending.newDeviceId });
    const linked = await enrolling;
    assert.equal(linked.accountId, primary.ownerAccountId);
    assert.equal(linked.hasAdminRoot, false);
    const firstSession = await phone.call("runtime.connect");
    await phone.call("vault.lock");
    await phone.stop();
    const messageId = "live-linked-" + randomBytes(8).toString("hex");
    await peer.call("bus:message.send", { threadId: accepted.threadId, messageId, payload: { kind: "rez.chat.message.v1", text: "Live message to the linked iPhone" } });
    phone = open("delegated-phone");
    await phone.call("vault.unlock", { password });
    assert.equal((await phone.call("runtime.connect")).localInboxId, firstSession.localInboxId);
    await waitFor(async () => {
      for (const thread of (await phone.call("bus:threads.list")).threads) {
        if ((await phone.call("bus:thread.messages.list", { threadId: thread.threadId })).items.some((message) => message.messageId === messageId)) return true;
      }
      return false;
    }, "live linked-phone offline message");
    console.log("PASS: live account-home approval, native device linking, portable activation and linked-phone catch-up after restart");
  } finally {
    for (const app of apps) await app.stop();
    await primary.chatServer.stop();
  }
}
