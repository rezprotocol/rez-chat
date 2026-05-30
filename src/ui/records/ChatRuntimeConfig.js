import { RRecord } from "@rezprotocol/sdk/client";

export class ChatRuntimeConfig extends RRecord {
  static type = "chat.runtimeConfig";

  constructor(payload = {}) {
    super();
    const src = payload && typeof payload === "object" ? payload : {};
    const wsUrlStr = typeof src.wsUrl === "string" ? src.wsUrl.trim() : "";
    const rawUplinks = Array.isArray(src.uplinks)
      ? src.uplinks.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    this.uplinks = rawUplinks.length > 0 ? rawUplinks : (wsUrlStr ? [wsUrlStr] : []);
    const n = Number(src.warmSpareCount);
    this.warmSpareCount = Number.isFinite(n) && n > 0 ? n : 2;
    const features = src.features && typeof src.features === "object" ? src.features : {};
    this.features = {
      chatBackupV1: features.chatBackupV1 === true,
    };
    this.bridgeToken = typeof src.bridgeToken === "string" ? src.bridgeToken : "";
    this._seal();
  }

  validate() {
    this.assert(Array.isArray(this.uplinks), "uplinks must be array");
    this.assert(
      Number.isFinite(this.warmSpareCount) && this.warmSpareCount > 0,
      "warmSpareCount must be positive finite number"
    );
    this.assert(this.features && typeof this.features === "object", "features must be object");
  }
}
