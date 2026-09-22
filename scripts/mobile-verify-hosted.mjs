import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { MobileHostConfigV1 } from "../src/mobile/MobileHostRecords.js";
import { NativeTestApplication } from "../mobile/probes/NativeTestApplication.mjs";
import { verifyHostedDelegation } from "../mobile/probes/verifyHostedDelegation.mjs";

const root = path.resolve(import.meta.dirname, "..");
if (!process.argv[2]) throw new Error("Usage: node scripts/mobile-verify-hosted.mjs <deployment.json>; creates two isolated test accounts on that deployment");
const config = new MobileHostConfigV1(JSON.parse(await readFile(path.resolve(process.argv[2]), "utf8")));
const scratch = await mkdtemp(path.join(tmpdir(), "rez-hosted-mobile-"));
const apps = [];
const diagnostics = [];
const password = randomBytes(24).toString("base64url");
async function waitFor(read, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out: " + label + "\n" + diagnostics.slice(-12).join("\n"));
}
try {
  const binary = path.join(scratch, "native-probe");
  execFileSync("xcrun", ["swiftc", "-module-cache-path", path.join(scratch, "swift-cache"),
    ...["NativeCrypto.swift", "NativeKeychain.swift", "NativeStorage.swift", "NativeNetwork.swift", "NativeEngine.swift", "probe/main.swift"].map((name) => path.join(root, "mobile/apple", name)), "-o", binary], { stdio: "inherit" });
  const bundlePath = path.join(scratch, "hosted.js");
  const built = await build({ entryPoints: [path.join(root, "mobile/probes/hosted-application.js")], bundle: true, platform: "browser", format: "iife", external: ["node:*"], write: false });
  await writeFile(bundlePath, "globalThis.__rezHostedConfig=" + JSON.stringify(config.toJSON()) + ";\n" + built.outputFiles[0].text);
  const open = (name) => {
    const app = new NativeTestApplication(binary, bundlePath, path.join(scratch, name), name, diagnostics);
    apps.push(app);
    return app;
  };
  let alice = open("alice");
  const bob = open("bob");
  await alice.call("vault.createAccount", { profileName: "iOS acceptance Alice", password });
  await bob.call("vault.createAccount", { profileName: "iOS acceptance Bob", password });
  const firstSession = await alice.call("runtime.connect");
  await bob.call("runtime.connect");
  const invite = await alice.call("bus:invite.create", { kind: "direct", maxUses: 1, creatorDisplayName: "iOS acceptance Alice" });
  const accepted = await bob.call("bus:invite.accept", { inviteCode: invite.inviteCode, acceptorDisplayName: "iOS acceptance Bob" });
  await waitFor(async () => {
    const contacts = await alice.call("bus:contacts.list");
    return contacts.items.some((contact) => contact.accountId === accepted.peerAccountId && contact.displayName === "iOS acceptance Bob");
  }, "inviter contact receives the phone acceptor name");
  await waitFor(async () => {
    const contacts = await bob.call("bus:contacts.list");
    return contacts.items.some((contact) => contact.displayName === "iOS acceptance Alice");
  }, "phone contact receives the inviter name");
  const messageId = "hosted-mobile-" + randomBytes(8).toString("hex");
  const text = "Live native iPhone acceptance " + messageId;
  await alice.call("vault.lock");
  await alice.stop();
  await bob.call("bus:message.send", { threadId: accepted.threadId, messageId, payload: { kind: "rez.chat.message.v1", text } });
  alice = open("alice");
  await alice.call("vault.unlock", { password });
  const restarted = await alice.call("runtime.connect");
  assert.equal(restarted.localInboxId, firstSession.localInboxId);
  const receivedThread = await waitFor(async () => {
    for (const thread of (await alice.call("bus:threads.list")).threads) {
      const messages = await alice.call("bus:thread.messages.list", { threadId: thread.threadId });
      if (messages.items.some((message) => message.text === text)) return thread.threadId;
    }
    return null;
  }, "live offline message catch-up");
  await waitFor(async () => (await bob.call("bus:thread.messages.list", { threadId: accepted.threadId })).items.some((message) => message.messageId === messageId && message.status === "delivered"), "verified live delivery acknowledgement");
  const attachmentBytes = Buffer.from("Native file over the live Rez TLS deployment.");
  const attachment = await alice.call("bus:file.send", { threadId: receivedThread, fileName: "native-live-test.txt", mimeType: "text/plain", fileDataB64: attachmentBytes.toString("base64") });
  await waitFor(async () => (await bob.call("bus:file.get", { fileHashHex: attachment.fileHashHex })).fileDataB64 === attachmentBytes.toString("base64"), "live reverse attachment delivery");
  console.log("PASS: live TLS native account creation, invite, offline encrypted delivery, restart, verified receipt and reverse attachment");
  if (process.argv.includes("--delegated")) await verifyHostedDelegation(binary, bundlePath, scratch, config);
} finally {
  for (const app of apps) await app.stop();
  await rm(scratch, { recursive: true, force: true });
}
