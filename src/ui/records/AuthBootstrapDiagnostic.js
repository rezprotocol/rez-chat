import { RRecord } from "@rezprotocol/sdk/client";

export class AuthBootstrapDiagnostic extends RRecord {
  static type = "chat.authBootstrapDiagnostic";

  constructor(raw = {}) {
    super();
    const src = raw && typeof raw === "object" ? raw : {};
    this.storageKind = typeof src.storageKind === "string" ? src.storageKind : "";
    this.dbName = typeof src.dbName === "string" ? src.dbName : "";
    this.storeName = typeof src.storeName === "string" ? src.storeName : "";
    this.storageKeys = Array.isArray(src.storageKeys)
      ? src.storageKeys.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    this.registryPresent = src.registryPresent === true;
    this.registryAccountIds = Array.isArray(src.registryAccountIds)
      ? src.registryAccountIds.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    this.registryHintsCount = Number.isFinite(Number(src.registryHintsCount)) ? Number(src.registryHintsCount) : 0;
    this.defaultEnvelopePresent = src.defaultEnvelopePresent === true;
    this.discoveredEnvelopeKeys = Array.isArray(src.discoveredEnvelopeKeys)
      ? src.discoveredEnvelopeKeys.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    this.orphanEnvelopeKeys = Array.isArray(src.orphanEnvelopeKeys)
      ? src.orphanEnvelopeKeys.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    this.selectedAccountId = typeof src.selectedAccountId === "string" ? src.selectedAccountId : "";
    this.resolvedStatus = typeof src.resolvedStatus === "string" ? src.resolvedStatus : "";
    this.reason = typeof src.reason === "string" ? src.reason : "";
    this._seal();
  }

  validate() {
    this.assert(typeof this.storageKind === "string", "storageKind must be string");
    this.assert(typeof this.dbName === "string", "dbName must be string");
    this.assert(typeof this.storeName === "string", "storeName must be string");
    this.assert(Array.isArray(this.storageKeys), "storageKeys must be array");
    this.assert(typeof this.registryPresent === "boolean", "registryPresent must be boolean");
    this.assert(Array.isArray(this.registryAccountIds), "registryAccountIds must be array");
    this.assert(Number.isFinite(this.registryHintsCount), "registryHintsCount must be finite");
    this.assert(typeof this.defaultEnvelopePresent === "boolean", "defaultEnvelopePresent must be boolean");
    this.assert(Array.isArray(this.discoveredEnvelopeKeys), "discoveredEnvelopeKeys must be array");
    this.assert(Array.isArray(this.orphanEnvelopeKeys), "orphanEnvelopeKeys must be array");
    this.assert(typeof this.selectedAccountId === "string", "selectedAccountId must be string");
    this.assert(typeof this.resolvedStatus === "string", "resolvedStatus must be string");
    this.assert(typeof this.reason === "string", "reason must be string");
  }
}
