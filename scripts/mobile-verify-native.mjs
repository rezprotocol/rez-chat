import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, pbkdf2Sync, sign, verify, createCipheriv, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { startRezNode } from "@rezprotocol/node";
import net from "node:net";
import { NativeTestApplication } from "../mobile/probes/NativeTestApplication.mjs";
import { verifyNativeDelegation } from "../mobile/probes/verifyNativeDelegation.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(path.join(tmpdir(), "rez-native-verify-"));
const binary = path.join(scratch, "native-probe");
let holder;
let provider;
let relay;
const applications = [];
const diagnostics = [];
try {
  execFileSync("xcrun", ["swiftc", "-module-cache-path", path.join(scratch, "swift-cache"),
    ...["NativeCrypto.swift", "NativeKeychain.swift", "NativeStorage.swift", "NativeNetwork.swift", "NativeEngine.swift", "probe/main.swift"].map((file) => path.join(root, "mobile/apple", file)), "-o", binary], { stdio: "inherit" });
  const message = Buffer.from("Rez native crypto interop");
  const ed = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
  const curveKey = (byte) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.alloc(32, byte)]), format: "der", type: "pkcs8" });
  const dhAlice = curveKey(9), dhBob = curveKey(11);
  const dh = diffieHellman({ privateKey: dhAlice, publicKey: createPublicKey(dhBob) });
  const hkdf = Buffer.from(hkdfSync("sha256", dh, message, message, 32));
  const cipher = createCipheriv("aes-256-gcm", hkdf, Buffer.alloc(12, 3));
  cipher.setAAD(message);
  const ciphertext = Buffer.concat([cipher.update(message), cipher.final(), cipher.getAuthTag()]);
  const expected = Object.fromEntries(Object.entries({ message, publicKey: createPublicKey(ed).export({ format: "der", type: "spki" }), signature: sign(null, message, ed), pbkdf: pbkdf2Sync(message, message, 1000, 32, "sha256"), dhPrivate: dhAlice.export({ format: "der", type: "pkcs8" }), dhPublic: createPublicKey(dhBob).export({ format: "der", type: "spki" }), dh, hkdf, ciphertext, sha256: createHash("sha256").update(message).digest() }).map(([key, value]) => [key, Array.from(value)]));
  async function bundle(name, prefix) {
    const output = path.join(scratch, name + ".js");
    const result = await build({ entryPoints: [path.join(root, "mobile/probes", name + ".js")], bundle: true, platform: "browser", format: "iife", external: ["node:*"], write: false, metafile: true });
    assert(!Object.keys(result.metafile.inputs).some((file) => file.endsWith("storage/fs/FileSystemDataStore.js")), "Desktop filesystem leaked into native bundle");
    await writeFile(output, prefix + "\n" + result.outputFiles[0].text);
    return output;
  }
  const crypto = await bundle("crypto", "globalThis.__rezExpectedCrypto=" + JSON.stringify(expected) + ";");
  const cryptoOutput = execFileSync(binary, [crypto], { encoding: "utf8" });
  const cryptoResult = cryptoOutput.trim().split("\n").map((line) => JSON.parse(line)).find((item) => item.complete);
  assert(cryptoResult && cryptoResult.ok, "Native cryptographic checks failed");
  assert(verify(null, message, createPublicKey(ed), Buffer.from(cryptoResult.signature)), "Native signature rejected by Node verifier");
  const store = path.join(scratch, "store");
  const env = { ...process.env, REZ_NATIVE_PROBE_STORE: store };
  const storageBundle = async (mode) => {
    const source = await bundle("storage", "globalThis.__rezStorageMode=" + JSON.stringify(mode) + ";");
    const target = path.join(scratch, "storage-" + mode + ".js");
    await writeFile(target, await readFile(source));
    return target;
  };
  holder = spawn(binary, [await storageBundle("hold")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native lock holder did not become ready")), 10000);
    holder.stdout.on("data", (data) => { if (data.toString().includes('"ready":true')) { clearTimeout(timer); resolve(); } });
    holder.once("error", reject);
    holder.once("exit", (code) => { clearTimeout(timer); reject(new Error("Native holder exited " + code)); });
  });
  await ready;
  execFileSync(binary, [await storageBundle("blocked")], { env, stdio: "inherit" });
  const died = once(holder, "exit");
  holder.kill("SIGKILL");
  await died;
  holder = null;
  execFileSync(binary, [await storageBundle("read")], { env, stdio: "inherit" });
  const db = new DatabaseSync(path.join(store, "store.sqlite"));
  const row = db.prepare("SELECT value FROM kv WHERE scope='alice' AND key='persist'").get();
  assert(!Buffer.from(row.value).includes("persisted private content"), "Plaintext stored on disk");
  db.prepare("UPDATE kv SET value=? WHERE scope='alice' AND key='persist'").run(Buffer.alloc(40));
  db.close();
  execFileSync(binary, [await storageBundle("corrupt")], { env, stdio: "inherit" });
  const vaultEnv = { ...process.env, REZ_NATIVE_PROBE_STORE: path.join(scratch, "vault-store") };
  const vaultCreate = await bundle("vault", 'globalThis.__rezVaultMode="create";');
  const parseCompleted = (output) => output.trim().split("\n").map((line) => JSON.parse(line)).find((item) => item.complete);
  const created = parseCompleted(execFileSync(binary, [vaultCreate], { env: vaultEnv, encoding: "utf8" }));
  const vaultUnlock = await bundle("vault", 'globalThis.__rezVaultMode="unlock";');
  const unlocked = parseCompleted(execFileSync(binary, [vaultUnlock], { env: vaultEnv, encoding: "utf8" }));
  assert.deepEqual(unlocked, created, "Native vault restart changed account or device identity");
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve, reject) => reserve.close((err) => err ? reject(err) : resolve()));
  relay = await startRezNode({ node: {
    mode: "relay-only", storage: { dataDir: path.join(scratch, "relay") },
    network: { knownRelays: [] }, mesh: { mode: "seed-only", seeds: [] },
    relay: { listenHost: "127.0.0.1", listenPort: 0, advertisedHost: "127.0.0.1" },
  } });
  const relayKeyId = relay.runtime.getIdentity().relayKeyId;
  provider = await startRezNode({ node: {
    ws: { host: "127.0.0.1", port, path: "/ws" },
    storage: { dataDir: path.join(scratch, "provider") },
    network: { participateInRouting: true, knownRelays: [{ id: relayKeyId, relayKeyId, host: "127.0.0.1", port: relay.relayAddress.port, transport: "tcp", insecure: true, tls: false }] },
    mesh: { enabled: true, mode: "seed-only", seeds: [], minPeers: 1, maxPeers: 5, policy: { defaultHops: 1, forceOnionRouting: false } },
    relay: { listenHost: "127.0.0.1", listenPort: 0 },
  } });
  const coreBundle = await bundle("core", "globalThis.__rezProbeUplink=" + JSON.stringify("ws://127.0.0.1:" + port + "/ws") + ";");
  async function runCore() {
    const child = spawn(binary, [coreBundle], { env: { ...process.env, REZ_NATIVE_PROBE_STORE: path.join(scratch, "core-store") }, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    const result = output.trim().split("\n").map((line) => JSON.parse(line)).find((item) => item.complete);
    assert(result && result.ok, output);
    return result;
  }
  const firstCore = await runCore();
  const restartedCore = await runCore();
  assert.equal(firstCore.inboxId, restartedCore.inboxId, "Native restart replaced durable inbox");
  const applicationBundle = await bundle("application", "globalThis.__rezProbeUplink=" + JSON.stringify("ws://127.0.0.1:" + port + "/ws") + ";");
  function application(label) {
    const host = new NativeTestApplication(binary, applicationBundle, path.join(scratch, label), label, diagnostics);
    applications.push(host.process);
    const call = host.call.bind(host);
    call.stop = () => host.stop();
    return call;
  }
  const alice = application("alice"), bob = application("bob");
  await alice("vault.createAccount", { profileName: "Alice native", password: "native-test-password" });
  await bob("vault.createAccount", { profileName: "Bob native", password: "native-test-password" });
  const aliceSession = await alice("runtime.connect");
  const bobSession = await bob("runtime.connect");
  assert.notEqual(aliceSession.accountId, bobSession.accountId);
  assert.notEqual(aliceSession.localInboxId, bobSession.localInboxId);
  const invite = await alice("bus:invite.create", { kind: "direct", maxUses: 1, creatorDisplayName: "Alice native" });
  const accepted = await bob("bus:invite.accept", { inviteCode: invite.inviteCode, acceptorDisplayName: "Bob native" });
  assert.equal(accepted.peerAccountId, aliceSession.accountId);
  const text = "Native application message " + Date.now();
  await bob("bus:message.send", { threadId: accepted.threadId, messageId: "native-message-1", payload: { kind: "rez.chat.message.v1", text } });
  let receivedThread = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const threads = await alice("bus:threads.list");
    for (const thread of threads.threads || []) {
      const messages = await alice("bus:thread.messages.list", { threadId: thread.threadId });
      if (messages.items.some((message) => message.text === text)) receivedThread = thread.threadId;
    }
    if (receivedThread) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(receivedThread, "Native application did not receive decrypted message\n" + diagnostics.slice(-30).join("\n"));
  async function confirmed(call, threadId, messageId) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const messages = await call("bus:thread.messages.list", { threadId });
      if (messages.items.some((message) => message.messageId === messageId && message.status === "delivered")) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail("Native sender did not receive a verified commit acknowledgement\n" + diagnostics.slice(-30).join("\n"));
  }
  await confirmed(bob, accepted.threadId, "native-message-1");
  await alice("bus:message.send", { threadId: receivedThread, messageId: "native-message-2", payload: { kind: "rez.chat.message.v1", text: "Native reply" } });
  await confirmed(alice, receivedThread, "native-message-2");
  // More than the old 1MB host ceiling, and several encrypted file chunks.
  const attachmentBytes = Buffer.alloc(800_000, 37);
  const attachment = await bob("bus:file.send", { threadId: accepted.threadId, fileDataB64: attachmentBytes.toString("base64"), fileName: "native-document.txt", mimeType: "text/plain", text: "Native attachment" });
  let receivedFile = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    receivedFile = await alice("bus:file.get", { fileHashHex: attachment.fileHashHex });
    if (receivedFile.fileDataB64) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.deepEqual(Buffer.from(receivedFile.fileDataB64, "base64"), attachmentBytes, "Native attachment bytes were not delivered intact");
  await alice("vault.lock");
  await bob("vault.lock");
  await alice.stop();
  const restartedAlice = application("alice");
  await restartedAlice("vault.unlock", { password: "native-test-password" });
  const restartedSession = await restartedAlice("runtime.connect");
  assert.equal(restartedSession.localInboxId, aliceSession.localInboxId);
  const history = await restartedAlice("bus:thread.messages.list", { threadId: receivedThread });
  assert(history.items.some((message) => message.text === text), "Received history lost across native process restart");
  assert(history.items.some((message) => message.messageId === "native-message-2" && message.status === "delivered"), "Verified sent status lost across restart");
  assert.deepEqual(Buffer.from((await restartedAlice("bus:file.get", { fileHashHex: attachment.fileHashHex })).fileDataB64, "base64"), attachmentBytes, "Native attachment lost across restart");
  await restartedAlice("vault.lock");
  if (process.argv.includes("--delegated")) await verifyNativeDelegation(binary, bundle, scratch, relay, "ws://127.0.0.1:" + port + "/ws", diagnostics);
  console.log("PASS: native crypto references, owner isolation, process exclusion, SIGKILL recovery, fencing and corruption rejection");
  console.log("PASS: native headless claimant boot, foreground convergence and restart against real portable provider");
  console.log("PASS: native recoverable account creation, cold unlock and wrong-password rejection");
  console.log("PASS: two native application hosts exchange encrypted messages, verify commit acknowledgements and retain history across restart");
  console.log("PASS: native attachment above the previous host limit arrives byte-for-byte and survives restart");
} finally {
  if (holder) holder.kill("SIGKILL");
  await Promise.all(applications.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }));
  if (provider) await provider.stop();
  if (relay) await relay.stop();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
