import {
  KeystoreFetchParams,
  KeystoreFetchResult,
  KeystorePutParams,
  KeystorePutResult,
  SessionHelloParams,
  SessionHelloResult,
} from "../../records/index.js";
import { BaseServerService } from "../base/BaseServerService.js";

export class ServerSessionService extends BaseServerService {
  #storageProvider;

  constructor({ bus, storageProvider, ownerAccountId, logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ServerSessionService requires storageProvider");
    }
    this.#storageProvider = storageProvider;
    this._register("session", "hello", (payload) => this.hello(payload));
    this._register("keystore", "put", (payload) => this.putKeystore(payload));
    this._register("keystore", "fetch", (payload) => this.fetchKeystore(payload));
  }

  getSessionInfo() {
    const sdk = this.bus.runtime && this.bus.runtime.sdk ? this.bus.runtime.sdk : null;
    const sdkSession = sdk && typeof sdk.getSessionInfo === "function" ? sdk.getSessionInfo() : {};
    const capabilities = sdkSession && typeof sdkSession === "object" ? sdkSession.capabilities : null;
    const localInboxId = capabilities && typeof capabilities === "object"
      ? String(capabilities.localInboxId || "").trim()
      : "";
    return {
      accountId: this.ownerAccountId,
      deviceId: "server",
      localInboxId,
    };
  }

  async hello(payload = {}) {
    const params = this._coerceParams(payload, SessionHelloParams);
    const session = this.getSessionInfo();
    return new SessionHelloResult({
      accountId: params.accountId,
      deviceId: params.deviceId,
      ownerAccountId: this.ownerAccountId,
      localInboxId: session.localInboxId,
    });
  }

  async putKeystore(payload = {}) {
    const params = this._coerceParams(payload, KeystorePutParams);
    const kv = this.#storageProvider.getKeyValueStore("app:keystore");
    await kv.set("keystore/" + params.accountId, params.envelope);
    return new KeystorePutResult({ ok: true });
  }

  async fetchKeystore(payload = {}) {
    const params = this._coerceParams(payload, KeystoreFetchParams);
    const kv = this.#storageProvider.getKeyValueStore("app:keystore");
    const envelope = await kv.get("keystore/" + params.accountId);
    return new KeystoreFetchResult({
      envelope: envelope && typeof envelope === "object" ? envelope : null,
    });
  }
}
