import { resolveSessionIdentity } from "@rezprotocol/sdk/client";

export class SdkSessionService {
  constructor({
    accountAuthService,
    sdkClientFactory = null,
    sdkClient = null,
    logger = console,
  } = {}) {
    if (!accountAuthService) {
      throw new Error("SdkSessionService requires accountAuthService");
    }
    if (!sdkClient && typeof sdkClientFactory !== "function") {
      throw new Error("SdkSessionService requires sdkClientFactory or sdkClient");
    }
    this._accountAuthService = accountAuthService;
    this._sdkClientFactory = sdkClientFactory;
    this._sdkClientStatic = sdkClient;
    this._logger = logger;
    this._sdkClient = null;
    this._sessionHandles = null;
    this._connectedIdentity = null;
  }

  getClient() {
    return this._sdkClient;
  }

  getSessionHandles() {
    return this._sessionHandles ? JSON.parse(JSON.stringify(this._sessionHandles)) : null;
  }

  async connectClient() {
    const account = this._accountAuthService.getAccount();
    if (!account) throw new Error("No unlocked account");
    const connectResult = await this._connectClient(account);
    this._sessionHandles = connectResult.sessionHandles;
    const envelope = this._accountAuthService.takePendingServerSyncEnvelope();
    if (envelope) {
      this._syncKeystoreToServer(envelope, connectResult.client).catch((err) => {
        if (this._logger && typeof this._logger.warn === "function") {
          this._logger.warn("keystore server sync failed", err && err.message ? err.message : err);
        }
      });
    }
    return connectResult;
  }

  async disconnect() {
    await this._closeClient();
    this._sessionHandles = null;
  }

  async _syncKeystoreToServer(envelope, client) {
    if (!envelope || !client) return;
    if (typeof client.putKeystore !== "function") return;
    try {
      await client.putKeystore({ envelope });
    } catch (err) {
      if (this._logger && typeof this._logger.warn === "function") {
        this._logger.warn("keystore.put sync failed", err && err.message ? err.message : String(err));
      }
    }
  }

  async _buildClient(account) {
    if (this._sdkClientStatic) return this._sdkClientStatic;
    const client = this._sdkClientFactory({ account });
    if (!client || typeof client !== "object") {
      throw new Error("SDK client factory returned invalid client");
    }
    return client;
  }

  async _closeClient() {
    const current = this._sdkClient;
    this._sdkClient = null;
    this._connectedIdentity = null;
    if (current && typeof current.close === "function") {
      await current.close().catch((err) => {
        if (this._logger && typeof this._logger.error === "function") {
          this._logger.error("auth logout close failed", err && err.message ? err.message : err);
        }
      });
    }
  }

  async _connectClient(account) {
    const expectedAccountId = String(account && account.accountId ? account.accountId : "").trim();
    const expectedDeviceId = String(account && account.deviceId ? account.deviceId : "").trim();
    const sameIdentity =
      !!this._sdkClient &&
      !!this._connectedIdentity &&
      this._connectedIdentity.accountId === expectedAccountId &&
      this._connectedIdentity.deviceId === expectedDeviceId;

    let client = this._sdkClient;
    if (!sameIdentity) {
      await this._closeClient();
      client = await this._buildClient(account);
      this._sdkClient = client;
      if (typeof client.connect === "function") {
        await client.connect();
      }
    }

    const sessionInfo = typeof client.getSessionInfo === "function"
      ? (client.getSessionInfo() || {})
      : {};
    const sessionIdentity = resolveSessionIdentity(sessionInfo, {
      accountId: expectedAccountId,
      deviceId: expectedDeviceId,
    });
    const accountId = String(sessionIdentity.accountId || "").trim();
    const deviceId = String(sessionIdentity.deviceId || "").trim();
    const localInboxId = sessionIdentity.localInboxId;
    const ownerAccountId = String(sessionInfo.ownerAccountId || "").trim() || null;

    if (!accountId || !deviceId) {
      throw new Error("SDK session did not provide account/device identity");
    }

    this._connectedIdentity = { accountId, deviceId };
    return {
      client,
      accountId,
      deviceId,
      sessionHandles: {
        localInboxId,
        ownerAccountId,
      },
    };
  }
}
