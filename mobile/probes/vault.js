import { installNativePlatform } from "@rezprotocol/sdk/native";
import { MobileApplicationHost } from "../../src/mobile/MobileApplicationHost.js";
import { MobileHostConfigV1, MobileHostRequestV1 } from "../../src/mobile/MobileHostRecords.js";

async function probe() {
  let sequence = 0;
  let response = null;
  const primitive = installNativePlatform(__rezNativeInvoke);
  const host = new MobileApplicationHost(
    new MobileHostConfigV1({
      accountHomeUplinks: ["wss://home.example/ws"],
      portableUplinks: ["wss://portable.example/ws"],
    }),
    primitive,
    (record) => { response = record; },
  );
  const call = async (operation, params = {}) => {
    response = null;
    await host.dispatch(new MobileHostRequestV1({
      id: "vault-probe:" + (++sequence),
      operation,
      paramsJson: JSON.stringify(params),
    }));
    if (!response || !response.ok) throw new Error(response ? response.error : "Mobile host returned no response");
    return JSON.parse(response.resultJson);
  };
  const mode = globalThis.__rezVaultMode;
  if (mode === "create") {
    await call("vault.createAccount", { password: "native-probe-password", profileName: "Native test" });
  } else {
    await call("vault.unlock", { password: "native-probe-password" });
  }
  const summary = await call("vault.getActiveIdentitySummary");
  if (!summary.accountId || !summary.deviceId || !summary.hasAdminRoot) throw new Error("Native account creation failed");
  const serialized = JSON.stringify(summary);
  if (serialized.includes("privateKey") || serialized.includes("mnemonic")) throw new Error("Secret leaked through identity summary");
  const phrase = await call("vault.revealMnemonic", { password: "native-probe-password" });
  let hidden = false;
  try { await call("vault.revealMnemonic", { password: "incorrect-password" }); } catch { hidden = true; }
  if (!hidden) throw new Error("Recovery phrase exposed without password verification");
  await call("vault.changePassword", { oldPassword: "native-probe-password", newPassword: "changed-probe-password" });
  await call("vault.resetPasswordWithMnemonic", { mnemonic: phrase.mnemonic, newPassword: "native-probe-password" });
  const locked = await call("vault.getActiveIdentitySummary");
  if (locked !== null) throw new Error("Recovery left account unlocked");
  const recovered = await call("vault.unlock", { password: "native-probe-password" });
  if (recovered.accountId !== summary.accountId || recovered.deviceId !== summary.deviceId) throw new Error("Recovery replaced existing device keys");
  await call("vault.lock");
  let rejected = false;
  try { await call("vault.unlock", { password: "incorrect-password" }); } catch { rejected = true; }
  if (!rejected) throw new Error("Incorrect password did not fail closed");
  __rezResult(JSON.stringify({ complete: true, ok: true, accountId: summary.accountId, deviceId: summary.deviceId }));
}
probe().catch((err) => __rezResult(JSON.stringify({ complete: true, ok: false, error: String(err) + "\n" + String(err.stack || "") })));
