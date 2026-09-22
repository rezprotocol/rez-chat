import { installNativePlatform, NativeStorageProvider } from "@rezprotocol/sdk/native";
import { BrowserCryptoProvider, bytesToBase64, deriveAccountIdFromPublicKey } from "@rezprotocol/sdk/client";
import { startRezChatCore } from "../../src/mobile/startRezChatCore.js";

async function probe() {
  const primitive = installNativePlatform(globalThis.__rezNativeInvoke);
  const cryptoProvider = new BrowserCryptoProvider();
  const storageProvider = new NativeStorageProvider(primitive);
  const key = await cryptoProvider.signingKeyPairFromSeed(new Uint8Array(32).fill(29));
  const identity = {
    accountId: deriveAccountIdFromPublicKey(key.publicKey),
    deviceId: "dev:native-engine-probe",
    publicKeyB64: bytesToBase64(key.publicKey),
    privateKeyB64: bytesToBase64(key.privateKey),
  };
  const core = await startRezChatCore({ identity, storageProvider, cryptoProvider, uplinks: [globalThis.__rezProbeUplink], wsFactory: (url) => new WebSocket(url) });
  let inboxId;
  try {
    await core.chatServer.start();
    if (!core.chatServer.bus.services.runtime.connected) throw new Error("Native claimant failed to connect");
    const report = await core.adapter.onForeground();
    if (!report.live) throw new Error("Native foreground did not converge");
    for (const [name, step] of Object.entries(report.steps)) if (!step.ok) throw new Error("Native convergence failed: " + name + " " + JSON.stringify(step));
    if (core.chatServer.bus.runtime.accountControl.executeCount !== 0) throw new Error("Wake used account authority");
    const lease = core.inboxClaimant.claimStore.leaseState(core.inboxClaimant.inboxId);
    if (!lease || lease.retentionClass !== "standard") throw new Error("Native portable lease missing");
    inboxId = core.inboxClaimant.inboxId;
  } finally { await core.chatServer.stop(); }
  __rezResult(JSON.stringify({ complete: true, ok: true, inboxId }));
}
probe().catch((err) => __rezResult(JSON.stringify({ complete: true, ok: false, error: String(err) + "\n" + String(err.stack || "") })));
