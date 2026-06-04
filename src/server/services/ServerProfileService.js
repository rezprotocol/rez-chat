import { ProfilePayloadV1 } from "@rezprotocol/sdk/profile";
import { base64ToBytes, bytesToBase64 } from "@rezprotocol/sdk/client";
import { Hash } from "@rezprotocol/sdk/hash";
import { ChatAvatarPayloadV1 } from "../../records/payloads/ChatAvatarPayloadV1.js";
import { PROFILE_KIND } from "../../records/payloads/index.js";
import { BaseServerService } from "../base/BaseServerService.js";
import { ProfileBroadcastResult } from "../../records/results/ProfileBroadcastResult.js";
import { ProfileGetOwnResult } from "../../records/results/ProfileGetOwnResult.js";
import { ContactUpdatedEvent } from "../../records/events/ContactUpdatedEvent.js";

const PROFILE_META_KEY = "app:profile:owner";

export class ServerProfileService extends BaseServerService {
  #contactStore;
  #threadStore;
  #clock;
  #ownerDisplayName;
  #ownerAvatarFileHash;
  #kvStore;

  constructor({ bus, contactStore, threadStore, storageProvider, ownerAccountId, ownerDisplayName = null, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!contactStore) {
      throw new Error("ServerProfileService requires contactStore");
    }
    if (!threadStore) {
      throw new Error("ServerProfileService requires threadStore");
    }
    this.#contactStore = contactStore;
    this.#threadStore = threadStore;
    this.#clock = clock;
    this.#ownerDisplayName = typeof ownerDisplayName === "string" && ownerDisplayName.trim().length > 0
      ? ownerDisplayName.trim()
      : null;
    this.#ownerAvatarFileHash = null;
    this.#kvStore = storageProvider && typeof storageProvider.getKeyValueStore === "function"
      ? storageProvider.getKeyValueStore(ownerAccountId.trim())
      : null;
    this._register("profile", "broadcastUpdate", (payload) => this.broadcastUpdate(payload));
    this._register("profile", "getOwn", () => this.getOwn());
  }

  async start() {
    await super.start();
    await this.#loadProfileMeta();
  }

  async #loadProfileMeta() {
    if (!this.#kvStore) return;
    const meta = await Promise.resolve(this.#kvStore.get(PROFILE_META_KEY)).catch(() => null);
    if (!meta || typeof meta !== "object") return;
    if (typeof meta.displayName === "string" && meta.displayName.length > 0 && !this.#ownerDisplayName) {
      this.#ownerDisplayName = meta.displayName;
    }
    if (typeof meta.avatarFileHash === "string" && meta.avatarFileHash.length > 0) {
      this.#ownerAvatarFileHash = meta.avatarFileHash;
    }
  }

  async #persistProfileMeta() {
    if (!this.#kvStore) return;
    await Promise.resolve(this.#kvStore.set(PROFILE_META_KEY, {
      displayName: this.#ownerDisplayName || "",
      avatarFileHash: this.#ownerAvatarFileHash || "",
      updatedAtMs: this.#clock(),
    })).catch((err) => {
      this.logger.warn("[ServerProfileService] persist profile meta failed", err && err.message ? err.message : err);
    });
  }

  #getFileTransferService() {
    const ft = this.bus.services.fileTransfer;
    return ft && typeof ft.storeFile === "function" ? ft : null;
  }

  async broadcastUpdate({ displayName, avatarDataB64 } = {}) {
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      throw new Error("broadcastUpdate requires non-empty displayName");
    }
    this.#ownerDisplayName = displayName.trim();

    let avatarFileHash = this.#ownerAvatarFileHash;
    const ftService = this.#getFileTransferService();

    if (typeof avatarDataB64 === "string" && avatarDataB64.length > 0 && ftService) {
      const avatarBytes = base64ToBytes(avatarDataB64);
      const hash = Hash.sha256Hex(avatarBytes);
      await ftService.storeFile(hash, bytesToBase64(avatarBytes));
      avatarFileHash = hash;
      this.#ownerAvatarFileHash = hash;
    } else if (typeof avatarDataB64 === "string" && avatarDataB64.length === 0) {
      avatarFileHash = null;
      this.#ownerAvatarFileHash = null;
    }

    await this.#persistProfileMeta();

    const payload = new ProfilePayloadV1({
      displayName: displayName.trim(),
      updatedAtMs: this.#clock(),
      avatarFileHash: avatarFileHash || "",
    });

    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) {
      this.logger.warn("[ServerProfileService] sdk unavailable, skipping broadcast");
      return new ProfileBroadcastResult({ sent: 0, failed: 0, avatarFileHash: avatarFileHash || "" });
    }

    const plaintextBodyBytes = payload.toBytes();
    const threadIds = await this.#threadStore.listThreadIds();
    let sent = 0;
    let failed = 0;

    for (const threadId of threadIds) {
      const thread = await this.#threadStore.getThread(threadId).catch(() => null);
      if (!thread) continue;
      const peerAccountId = typeof thread.peerAccountId === "string" ? thread.peerAccountId.trim() : "";
      const peerInboxId = typeof thread.peerInboxId === "string" ? thread.peerInboxId.trim() : "";
      if (!peerAccountId || !peerInboxId) continue;
      if (peerAccountId === this.ownerAccountId) continue;

      try {
        if (avatarFileHash && ftService) {
          await this.#sendAvatarFileToPeer({
            sdk,
            peerAccountId,
            peerInboxId,
            avatarFileHash,
          });
        }
        const sealed = await sdk.sealForPeer({
          peerAccountId: peerAccountId,
          plaintextBodyBytes,
          deliverInboxId: peerInboxId,
        });
        await sdk.mesh.dispatch(
          sealed.object,
          sealed.address,
        );
        sent++;
      } catch (err) {
        failed++;
        this.logger.error(
          "[ServerProfileService] broadcast to " + peerAccountId + " failed",
          err && err.message ? err.message : err,
        );
      }
    }

    return new ProfileBroadcastResult({ sent, failed, avatarFileHash: avatarFileHash || "" });
  }

  getOwn() {
    return new ProfileGetOwnResult({
      displayName: this.#ownerDisplayName || "",
      avatarFileHash: this.#ownerAvatarFileHash || "",
    });
  }

  async sendProfileToPeer({ peerAccountId, threadId, peerInboxId } = {}) {
    if (typeof peerAccountId !== "string" || peerAccountId.trim().length === 0) return;
    if (typeof threadId !== "string" || threadId.trim().length === 0) return;

    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) return;

    const displayName = this.#ownerDisplayName;
    if (!displayName) return;

    let deliverTo = typeof peerInboxId === "string" && peerInboxId.trim().length > 0
      ? peerInboxId.trim()
      : null;

    if (!deliverTo) {
      const thread = await this.#threadStore.getThread(threadId).catch(() => null);
      if (thread && typeof thread.peerInboxId === "string" && thread.peerInboxId.trim().length > 0) {
        deliverTo = thread.peerInboxId.trim();
      }
    }
    if (!deliverTo) return;

    if (this.#ownerAvatarFileHash) {
      const peerFt = this.#getFileTransferService();
      if (peerFt) {
        await this.#sendAvatarFileToPeer({
          sdk,
          peerAccountId: peerAccountId.trim(),
          peerInboxId: deliverTo,
          avatarFileHash: this.#ownerAvatarFileHash,
        }).catch((err) => {
          this.logger.warn("[ServerProfileService] avatar send to peer failed", err && err.message ? err.message : err);
        });
      }
    }

    const payload = new ProfilePayloadV1({
      displayName,
      updatedAtMs: this.#clock(),
      avatarFileHash: this.#ownerAvatarFileHash || "",
    });

    const sealed = await sdk.sealForPeer({
      peerAccountId: peerAccountId.trim(),
      plaintextBodyBytes: payload.toBytes(),
      deliverInboxId: deliverTo,
    });
    await sdk.mesh.dispatch(
      sealed.object,
      sealed.address,
    );
  }

  async #sendAvatarFileToPeer({ sdk, peerAccountId, peerInboxId, avatarFileHash }) {
    const ft = this.#getFileTransferService();
    if (!ft) return;
    const b64 = await ft.retrieveFileB64(avatarFileHash);
    if (!b64) return;

    const avatarPayload = new ChatAvatarPayloadV1({
      fileHashHex: avatarFileHash,
      fileDataB64: b64,
    });
    const bodyBytes = new TextEncoder().encode(JSON.stringify(avatarPayload.toJSON()));
    const sealed = await sdk.sealForPeer({
      peerAccountId: peerAccountId,
      plaintextBodyBytes: bodyBytes,
      deliverInboxId: peerInboxId,
    });
    await sdk.mesh.dispatch(
      sealed.object,
      sealed.address,
    );
  }

  async handleIncomingProfile(record, { senderAccountId } = {}) {
    // The PAYLOAD_KIND_REGISTRY constructs ProfilePayloadV1 at the receive
    // boundary; we just sanity-check the type.
    if (!(record instanceof ProfilePayloadV1)) return false;
    if (typeof senderAccountId !== "string" || senderAccountId.trim().length === 0) return false;
    const profile = record;

    const existing = await this.#contactStore.get({
      ownerAccountId: this.ownerAccountId,
      accountId: senderAccountId.trim(),
    });

    if (existing && typeof existing.updatedAtMs === "number" && existing.updatedAtMs >= profile.updatedAtMs) {
      return true;
    }

    const patch = {
      displayName: profile.displayName,
      lastSeenAtMs: this.#clock(),
    };
    if (profile.avatarFileHash) {
      patch.avatarFileHash = profile.avatarFileHash;
    }

    const result = await this.#contactStore.upsert({
      ownerAccountId: this.ownerAccountId,
      accountId: senderAccountId.trim(),
      patch,
    });

    const updatedContact = result && result.contact ? result.contact : null;
    if (updatedContact) {
      this._emit("contact.updated", new ContactUpdatedEvent({ contact: updatedContact }));
    }
    return true;
  }
}
