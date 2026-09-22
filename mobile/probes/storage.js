import { NativePrimitiveClient, NativeStorageProvider } from "@rezprotocol/sdk/native";

async function probe() {
  const store = new NativeStorageProvider(new NativePrimitiveClient(globalThis.__rezNativeInvoke));
  const kv = store.getKeyValueStore("alice");
  const mode = globalThis.__rezStorageMode;
  if (mode === "corrupt") {
    let code = "";
    try { await kv.getStrict("persist"); } catch (err) { code = err.code; }
    if (code !== "KEY_VALUE_UNREADABLE") throw new Error("Corruption treated as absent");
  } else if (mode === "blocked") {
    let code = "";
    try { await store.acquireRuntimeOwnership(); } catch (err) { code = err.code; }
    if (code !== "DELIVERY_RUNTIME_ALREADY_ACTIVE") throw new Error("Concurrent process ownership accepted");
  } else {
    const grant = await store.acquireRuntimeOwnership();
    grant.assertActive();
    if (mode === "write" || mode === "hold") {
      await kv.set("persist", "persisted private content");
      if (await store.getKeyValueStore("bob").get("persist") !== undefined) throw new Error("Owner isolation failed");
      if (mode === "hold") {
        __rezResult(JSON.stringify({ ready: true }));
        await new Promise(() => {});
      }
    } else {
      if (await kv.get("persist") !== "persisted private content") throw new Error("Restart lost committed data");
      if (grant.runtimeEpoch < 2) throw new Error("Epoch did not advance across process death");
    }
    if (String(await kv.keys("per")) !== "persist") throw new Error("Key enumeration failed");
    await grant.release();
    let fenced = false;
    try { grant.assertActive(); } catch (err) { fenced = err.code === "DELIVERY_RUNTIME_FENCED"; }
    if (!fenced) throw new Error("Released owner was not fenced");
  }
  __rezResult(JSON.stringify({ complete: true, ok: true, mode }));
}
probe().catch((err) => __rezResult(JSON.stringify({ complete: true, ok: false, error: String(err) + "\n" + String(err.stack || "") })));
