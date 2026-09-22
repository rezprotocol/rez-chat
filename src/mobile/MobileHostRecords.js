import { RRecord, assertKeystoreEnvelope } from "@rezprotocol/sdk/client";

export class MobileHostConfigV1 extends RRecord {
  static type = "chat.mobile.hostConfig.v1";
  constructor(raw = {}) {
    super();
    this.accountHomeUplinks = Array.isArray(raw.accountHomeUplinks) ? raw.accountHomeUplinks.slice() : [];
    this.portableUplinks = Array.isArray(raw.portableUplinks) ? raw.portableUplinks.slice() : [];
    this.accountHomePin = raw.accountHomePin || "";
    this.portablePin = raw.portablePin || "";
    this._seal();
  }
  validate() {
    for (const urls of [this.accountHomeUplinks, this.portableUplinks]) {
      this.assert(urls.length > 0 && urls.length <= 8, "Mobile deployment requires enrollment-home and portable-provider addresses");
      for (const value of urls) {
        const url = new URL(value);
        this.assert(url.protocol === "wss:" && !url.username && !url.password && !url.hash, "Mobile deployment addresses must be secure WebSocket URLs");
      }
    }
    this.assert(typeof this.accountHomePin === "string" && typeof this.portablePin === "string", "Invalid provider identity pin");
  }
}

export class MobileAuthParamsV1 extends RRecord {
  static type = "chat.mobile.authParams.v1";
  constructor(raw = {}) {
    super();
    for (const key of ["accountId", "password", "oldPassword", "newPassword", "profileName", "linkCode", "mnemonic"]) this[key] = typeof raw[key] === "string" ? raw[key] : "";
    this._seal();
  }
  validate() { for (const value of Object.values(this)) if (typeof value === "string") this.assert(value.length <= 16384, "Mobile auth input too large"); }
}

export class LegacyMobileVaultRecordV1 extends RRecord {
  static type = "chat.mobile.legacyVault.v1";
  constructor(raw) {
    super();
    this.envelope = assertKeystoreEnvelope(raw.envelope);
    this.accountId = typeof raw.accountId === "string" ? raw.accountId : "";
    this.recoveryEnvelope = raw.recoveryEnvelope ? assertKeystoreEnvelope(raw.recoveryEnvelope) : null;
    this.recoveryKeystore = raw.recoveryKeystore ? assertKeystoreEnvelope(raw.recoveryKeystore) : null;
    this.label = typeof raw.label === "string" ? raw.label : "Rez account";
    this.avatar = new MobileAvatarV1(raw.avatar || {});
    this._seal();
  }
}

export class MobileProfileParamsV1 extends RRecord {
  static type = "chat.mobile.profileParams.v1";
  constructor(raw) {
    super();
    this.accountId = typeof raw.accountId === "string" ? raw.accountId : "";
    this.profileName = typeof raw.profileName === "string" ? raw.profileName : "";
    this.avatarFileHash = typeof raw.avatarFileHash === "string" ? raw.avatarFileHash : "";
    this.avatarDataB64 = typeof raw.avatarDataB64 === "string" ? raw.avatarDataB64 : "";
    this._seal();
  }
  validate() {
    this.assert(this.accountId.length <= 512 && this.profileName.length <= 128, "Profile input too large");
    this.assert(this.avatarFileHash.length <= 512 && this.avatarDataB64.length <= 524288, "Avatar input too large");
  }
}

export class MobileAvatarV1 extends RRecord {
  static type = "chat.mobile.avatar.v1";
  constructor(raw) { super(); this.avatarFileHash = raw.avatarFileHash || ""; this.avatarDataB64 = raw.avatarDataB64 || ""; this._seal(); }
  validate() {
    this.assert(typeof this.avatarFileHash === "string" && this.avatarFileHash.length <= 512, "Invalid avatar reference");
    this.assert(typeof this.avatarDataB64 === "string" && this.avatarDataB64.length <= 524288, "Invalid avatar data");
  }
}

export class MobileMnemonicResultV1 extends RRecord {
  static type = "chat.mobile.mnemonicResult.v1";
  constructor(mnemonic) { super(); this.mnemonic = mnemonic; this._seal(); }
  validate() { this.assert(typeof this.mnemonic === "string" && [12, 15, 18, 21, 24].includes(this.mnemonic.split(" ").length), "Invalid recovery phrase result"); }
}

export class MobileIdentitySummaryV1 extends RRecord {
  static type = "chat.mobile.identitySummary.v1";
  constructor(account, profileName = null) {
    super();
    this.accountId = account.accountId;
    this.deviceId = account.deviceId;
    this.identityPublicKey = account.identityPublicKey;
    this.profileName = typeof profileName === "string" ? profileName : account.profileName || "";
    this.hasAdminRoot = account.hasAdminRoot !== false;
    this._seal();
  }
  validate() { this.assert(typeof this.accountId === "string" && this.accountId.length > 0 && typeof this.deviceId === "string" && this.deviceId.length > 0, "Mobile identity is incomplete"); }
}

export class MobileVaultStatusV1 extends RRecord {
  static type = "chat.mobile.vaultStatus.v1";
  constructor(present, unlocked) { super(); this.hasAccounts = present; this.unlocked = unlocked; this.osWrapAvailable = false; this._seal(); }
}

export class MobileAccountListEntryV1 extends RRecord {
  static type = "chat.mobile.accountListEntry.v1";
  constructor(raw) {
    super();
    this.id = raw.id;
    this.label = raw.label;
    this.accountIdHint = raw.accountIdHint || null;
    this.deviceUnlockEnabled = false;
    this.recoveryEnabled = raw.recoveryEnabled !== false;
    this.delegated = raw.delegated === true;
    this._seal();
  }
  validate() { this.assert(typeof this.id === "string" && this.id.length > 0, "Mobile account entry requires id"); }
}

export class MobileAccountListV1 extends RRecord {
  static type = "chat.mobile.accountList.v1";
  constructor(accounts = []) {
    super();
    this.accounts = accounts.map((account) => account instanceof MobileAccountListEntryV1 ? account : new MobileAccountListEntryV1(account));
    this._seal();
  }
}

export class MobileHostRequestV1 extends RRecord {
  static type = "chat.mobile.hostRequest.v1";
  constructor(raw) { super(); this.id = raw.id; this.operation = raw.operation; this.paramsJson = raw.paramsJson; this._seal(); }
  validate() {
    this.assert(typeof this.id === "string" && this.id.length > 0 && this.id.length <= 128, "Invalid host request id");
    this.assert(typeof this.operation === "string" && this.operation.length <= 128, "Invalid host operation");
    // The shared composer accepts 10 MiB files (14M base64 characters).
    // Leave room for the envelope while retaining a bounded native IPC input.
    this.assert(typeof this.paramsJson === "string" && this.paramsJson.length <= 16 * 1024 * 1024, "Invalid host parameters");
  }
}

export class MobileHostResponseV1 extends RRecord {
  static type = "chat.mobile.hostResponse.v1";
  constructor(id, result = null, error = null) {
    super(); this.id = id; this.ok = error === null;
    this.resultJson = result === null ? "null" : JSON.stringify(result.toJSON());
    this.error = error ? String(error.message || error) : "";
    this.code = error && error.code ? String(error.code) : "";
    this._seal();
  }
}

export class MobileHostEventV1 extends RRecord {
  static type = "chat.mobile.hostEvent.v1";
  constructor(name, payload) { super(); this.event = name; this.payloadJson = JSON.stringify(payload.toJSON()); this._seal(); }
}

export class MobileLifecycleRequestV1 extends RRecord {
  static type = "chat.mobile.lifecycleRequest.v1";
  constructor(raw) { super(); this.id = raw.id; this.name = raw.name; this._seal(); }
  validate() {
    this.assert(typeof this.id === "string" && this.id.length > 0 && this.id.length <= 128, "Invalid lifecycle request id");
    this.assert(["onForeground", "onBackground", "onPushWake", "onNetworkAvailable", "onPeriodicWake"].includes(this.name), "Invalid mobile lifecycle event");
  }
}

export class MobileBackgroundReportV1 extends RRecord {
  static type = "chat.mobile.backgroundReport.v1";
  constructor() { super(); this.suspended = true; this._seal(); }
}

export class MobileLifecycleResultV1 extends RRecord {
  static type = "chat.mobile.lifecycleResult.v1";
  constructor(request, report, error = null) {
    super();
    this.id = request.id;
    this.ok = !error && report !== null && (request.name === "onBackground"
      ? report.suspended === true || report.reason === "no-account-control"
      : report.live === true && Object.values(report.steps).every((step) => step.ok && !step.skipped));
    this.reportJson = JSON.stringify(report);
    this.error = error ? String(error.message || error) : report === null ? "Mobile runtime is locked" : "";
    this._seal();
  }
}
