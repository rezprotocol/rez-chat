import { FileTransferService, FileManifestV1 } from "@rezprotocol/sdk/filetransfer";
import { base64ToBytes, bytesToBase64 } from "@rezprotocol/sdk/client";

function defaultAttachmentPreview(mimeType, fileName) {
  if (typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/")) {
    return "Photo";
  }
  if (typeof fileName === "string" && fileName.trim()) return fileName.trim();
  return "File";
}
import {
  FileSendParams,
  FileSendResult,
  FileGetParams,
  FileGetResult,
  MessageDepositedEvent,
  MessageStatusEvent,
} from "../../records/index.js";
import { ChatImagePayloadV1 } from "../../records/payloads/ChatImagePayloadV1.js";
import { BaseServerService } from "../base/BaseServerService.js";

export class ServerFileTransferService extends BaseServerService {
  #storageProvider;
  #clock;
  #kvStore;
  #fileTransferService;
  #sendContext;
  // transferId -> channelId, populated when an inbound manifest arrives.
  // Consumed (and cleared) in #handleFileReceived so the inbound
  // ChatImagePayloadV1 is stamped with the correct channel. The chat
  // layer carries channelId via a JSON augmentation on the manifest
  // (the rez-core FileManifestV1 record itself stays chat-agnostic), so
  // we capture it at the chat boundary before construction loses it.
  #transferChannels;

  constructor({ bus, storageProvider, ownerAccountId, clock = () => Date.now(), logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") {
      throw new Error("ServerFileTransferService requires storageProvider");
    }
    this.#storageProvider = storageProvider;
    this.#clock = clock;
    this.#kvStore = storageProvider.getKeyValueStore("app:filetransfer");
    this.#fileTransferService = null;
    this.#sendContext = null;
    this.#transferChannels = new Map();
    this._register("file", "send", (payload) => this.sendFile(payload));
    this._register("file", "get", (payload) => this.getFile(payload));
  }

  async storeFile(fileHashHex, fileDataB64) {
    if (typeof fileHashHex !== "string" || !fileHashHex.trim()) {
      throw new Error("storeFile requires fileHashHex");
    }
    if (typeof fileDataB64 !== "string" || !fileDataB64) {
      throw new Error("storeFile requires fileDataB64");
    }
    await this.#kvStore.set("file:" + fileHashHex.trim(), fileDataB64);
  }

  async retrieveFileB64(fileHashHex) {
    if (typeof fileHashHex !== "string" || !fileHashHex.trim()) return null;
    const b64 = await this.#kvStore.get("file:" + fileHashHex.trim());
    return typeof b64 === "string" ? b64 : null;
  }

  async start() {
    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) {
      throw new Error("ServerFileTransferService requires sdk with sealForPeer + mesh");
    }

    this.#fileTransferService = new FileTransferService({
      log: this.logger,
      kvStore: this.#kvStore,
      onSendDeposit: async ({ peerAccountId, contextId, plaintextBodyBytes }) => {
        const ctx = this.#sendContext;
        const deliverInboxId = ctx && typeof ctx.deliverInboxId === "string" && ctx.deliverInboxId
          ? ctx.deliverInboxId
          : undefined;
        const groupTargets = ctx && Array.isArray(ctx.groupTargets) ? ctx.groupTargets : null;
        const channelId = ctx && typeof ctx.channelId === "string" ? ctx.channelId : "";
        const localIdentity = typeof sdk.getIdentity === "function" ? sdk.getIdentity() : {};
        const receiptInboxId = typeof localIdentity.localInboxId === "string"
          ? localIdentity.localInboxId.trim()
          : undefined;
        // Chat-layer wire augmentation. The body bytes arriving here are a
        // serialized FileManifestV1 or FileChunkV1 — a rez-core protocol
        // record that intentionally knows nothing about chat (no threadId,
        // no senderAccountId). The chat layer adds those routing fields to
        // the outbound wire so the receiver's ServerEventService can route
        // the deposit to the right thread.
        //
        // This is the chat layer wrapping a core payload with chat
        // metadata, NOT a sin: core's records stay clean of chat concerns;
        // chat augments at its own boundary. The augmentation is in-place
        // on the JSON because there is no separate chat-layer envelope
        // record yet — promoting to one (e.g. ChatFilePayloadEnvelopeV1
        // around the core body) would be a wire-format change requiring
        // coordinated sender/receiver updates.
        let bodyBytes = plaintextBodyBytes;
        try {
          const payload = JSON.parse(new TextDecoder().decode(plaintextBodyBytes));
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            payload.threadId = contextId;
            payload.senderAccountId = this.ownerAccountId;
            if (channelId) payload.channelId = channelId;
            bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
          }
        } catch {
          bodyBytes = plaintextBodyBytes;
        }
        if (groupTargets) {
          if (groupTargets.length === 0) return;
          const results = await Promise.allSettled(
            groupTargets.map((accountId) => sdk.sealForPeer({
              peerAccountId: accountId,
              plaintextBodyBytes: bodyBytes,
              receiptInboxId: receiptInboxId || undefined,
            }).then((sealed) => sdk.mesh.dispatch(
              sealed.object,
              sealed.address,
            ))),
          );
          let failedCount = 0;
          for (const r of results) {
            if (r.status === "rejected") {
              failedCount++;
              this.logger.error(
                "[ServerFileTransferService] group fan-out deposit failed",
                r.reason && r.reason.message ? r.reason.message : r.reason,
              );
            }
          }
          if (failedCount === groupTargets.length) {
            throw new Error("ServerFileTransferService: group fan-out failed for all " + groupTargets.length + " targets");
          }
          return;
        }
        const sealed = await sdk.sealForPeer({
          peerAccountId,
          plaintextBodyBytes: bodyBytes,
          deliverInboxId,
          receiptInboxId: receiptInboxId || undefined,
        });
        await sdk.mesh.dispatch(
          sealed.object,
          sealed.address,
        );
      },
      onFileReceived: ({ transferId, manifest, fileBytes, senderAccountId, contextId }) => {
        this.#handleFileReceived({ transferId, manifest, fileBytes, senderAccountId, threadId: contextId }).catch((err) => {
          this.logger.error("[ServerFileTransferService] onFileReceived failed", err && err.message ? err.message : err);
          this._emit("app.error", { source: "ServerFileTransferService", message: "onFileReceived failed", severity: "error", err });
        });
      },
      onProgress: null,
    });
  }

  async sendFile(payload = {}) {
    const params = this._coerceParams(payload, FileSendParams);
    const fileBytes = base64ToBytes(params.fileDataB64);
    const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";

    const thread = await this.bus.stores.threadStore.getThread(params.threadId).catch(() => null);
    if (!thread) {
      throw new Error("ServerFileTransferService: thread not found for " + params.threadId);
    }

    const threadType = typeof thread.threadType === "string" ? thread.threadType : "";
    const threadGroupId = typeof thread.groupId === "string" ? thread.groupId.trim() : "";
    const peerAccountId = typeof thread.peerAccountId === "string" ? thread.peerAccountId.trim() : "";
    const deliverInboxId = typeof thread.peerInboxId === "string" ? thread.peerInboxId.trim() : "";

    let sdkPeerAccountId = peerAccountId;
    let groupTargets = null;
    let groupDeliverInboxId = "";
    if (threadType === "group" && threadGroupId) {
      const groupStore = this.bus.stores ? this.bus.stores.groupStore : null;
      if (!groupStore || typeof groupStore.listMembers !== "function") {
        throw new Error("ServerFileTransferService: groupStore unavailable for group thread " + params.threadId);
      }
      const members = await groupStore.listMembers({
        ownerAccountId: this.ownerAccountId,
        groupId: threadGroupId,
      });
      groupTargets = [];
      for (const member of members) {
        if (!member || member.state !== "active") continue;
        if (member.accountId === this.ownerAccountId) continue;
        groupTargets.push(member.accountId);
      }
      // The SDK validates peerAccountId is non-empty but otherwise just
      // hands it back to onSendDeposit. In group mode that callback fans
      // out via groupTargets and ignores this value; use ownerAccountId
      // as an inert sentinel.
      sdkPeerAccountId = this.ownerAccountId;
    } else if (!peerAccountId) {
      throw new Error("ServerFileTransferService: no peer account for thread " + params.threadId);
    }

    this.#sendContext = {
      deliverInboxId: groupTargets ? groupDeliverInboxId : deliverInboxId,
      groupTargets,
      channelId,
    };
    let result;
    try {
      result = await this.#fileTransferService.sendFile({
        fileBytes,
        fileName: params.fileName,
        mimeType: params.mimeType,
        peerAccountId: sdkPeerAccountId,
        contextId: params.threadId,
        text: params.text || "",
      });
    } finally {
      this.#sendContext = null;
    }

    const now = this.#clock();
    const messageId = "img_" + now + "_" + result.transferId;
    const captionText = params.text || "";
    const imagePayload = new ChatImagePayloadV1({
      fileName: params.fileName,
      mimeType: params.mimeType,
      fileSizeBytes: fileBytes.length,
      fileHashHex: result.manifest.fileHashHex,
      text: captionText,
      channelId,
    });

    await this.bus.stores.threadStore.recordOutboundDeposit({
      threadId: params.threadId,
      senderKey: this.ownerAccountId,
      messageId,
      senderAccountId: this.ownerAccountId,
      packetB64: JSON.stringify(imagePayload.toJSON()),
      acceptedAtMs: now,
      text: captionText,
      payload: imagePayload,
    }).catch((err) => {
      this.logger.error("[ServerFileTransferService] outbound deposit persist failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerFileTransferService", message: "outbound deposit persist failed", severity: "error", err });
    });

    const previewText = captionText || defaultAttachmentPreview(params.mimeType, params.fileName);
    const indexRecord = await this.bus.stores.threadIndex.upsertFromMessage({
      threadId: params.threadId,
      messageId: messageId,
      ts: now,
      preview: previewText,
      senderAccountId: this.ownerAccountId,
    }).catch((err) => {
      this.logger.error("[ServerFileTransferService] outbound index upsert failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerFileTransferService", message: "outbound index upsert failed", severity: "warn", err });
    });
    if (indexRecord && this.bus.services && this.bus.services.threads) {
      this.bus.services.threads.emitThreadIndexUpdated(indexRecord);
    }

    const outboundPacketB64 = JSON.stringify(imagePayload.toJSON());
    this._emit("message.deposited", new MessageDepositedEvent({
      threadId: params.threadId,
      message: {
        messageId,
        threadId: params.threadId,
        senderAccountId: this.ownerAccountId,
        senderKey: this.ownerAccountId,
        packetB64: outboundPacketB64,
        text: captionText,
        payload: imagePayload,
        status: "pending",
        createdAtMs: now,
        acceptedAtMs: now,
      },
    }));

    // sendFile above has already pushed all chunks through the SDK by the
    // time we get here. Mirror ServerMessagesService.sendMessage: persist
    // the "sent" transition to the DB and notify the renderer via a
    // dedicated message.status event. Without this the bubble is stuck on
    // "SENDING" because nothing ever moves the row off "pending".
    await this.bus.stores.threadStore.setMessageStatus({
      threadId: params.threadId,
      messageId,
      status: "sent",
      sentAtMs: now,
    }).catch((err) => {
      this.logger.error("[ServerFileTransferService] outbound status persist failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerFileTransferService", message: "outbound status persist failed", severity: "warn", err });
    });
    this._emit("message.status", new MessageStatusEvent({
      threadId: params.threadId,
      messageId,
      status: "sent",
      sentAtMs: now,
    }));

    return new FileSendResult({
      threadId: params.threadId,
      messageId: messageId,
      fileHashHex: result.manifest.fileHashHex,
      transferId: result.transferId,
    });
  }

  async getFile(payload = {}) {
    const params = this._coerceParams(payload, FileGetParams);
    const fileBytes = await this.#fileTransferService.getFile(params.fileHashHex);
    if (!fileBytes) {
      return new FileGetResult({
        fileHashHex: params.fileHashHex,
        fileDataB64: "",
        mimeType: "",
        fileName: "",
      });
    }
    return new FileGetResult({
      fileHashHex: params.fileHashHex,
      fileDataB64: bytesToBase64(fileBytes),
      mimeType: "",
      fileName: "",
    });
  }

  async handleIncomingPayload(payload, { senderAccountId, threadId, channelId } = {}) {
    if (!this.#fileTransferService) return false;
    // Manifests carry the chat-layer channelId augmentation. Stash it
    // keyed by transferId so #handleFileReceived can stamp the
    // resulting ChatImagePayloadV1 with the right channel — the
    // FileManifestV1 record itself is chat-agnostic and drops the field.
    if (payload instanceof FileManifestV1 && typeof payload.transferId === "string" && payload.transferId) {
      const ch = typeof channelId === "string" ? channelId : "";
      this.#transferChannels.set(payload.transferId, ch);
    }
    return this.#fileTransferService.handleIncomingPayload(payload, { senderAccountId, contextId: threadId });
  }

  async #handleFileReceived({ transferId, manifest, fileBytes, senderAccountId, threadId }) {
    const resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    const resolvedSender = typeof senderAccountId === "string" ? senderAccountId.trim() : "";

    if (!resolvedThreadId) {
      this.logger.error("[ServerFileTransferService] no thread context for completed transfer " + transferId);
      return;
    }

    const now = this.#clock();
    const messageId = "img_recv_" + now + "_" + transferId;
    const captionText = typeof manifest.text === "string" ? manifest.text : "";
    const channelId = this.#transferChannels.get(transferId) || "";
    this.#transferChannels.delete(transferId);
    const imagePayload = new ChatImagePayloadV1({
      fileName: manifest.fileName,
      mimeType: manifest.mimeType,
      fileSizeBytes: fileBytes.length,
      fileHashHex: manifest.fileHashHex,
      text: captionText,
      channelId,
    });

    await this.bus.stores.threadStore.upsertDepositedMessage({
      messageId,
      threadId: resolvedThreadId,
      senderKey: resolvedSender,
      packetB64: JSON.stringify(imagePayload.toJSON()),
      acceptedAtMs: now,
      senderAccountId: resolvedSender || null,
      status: "delivered",
      text: captionText,
      payload: imagePayload,
    }).catch((err) => {
      this.logger.error("[ServerFileTransferService] inbound image persist failed", err && err.message ? err.message : err);
    });

    const previewText = captionText || defaultAttachmentPreview(manifest.mimeType, manifest.fileName);
    const indexRecord = await this.bus.stores.threadIndex.upsertFromMessage({
      threadId: resolvedThreadId,
      messageId: messageId,
      ts: now,
      preview: previewText,
    }).catch((err) => {
      this.logger.error("[ServerFileTransferService] inbound index upsert failed", err && err.message ? err.message : err);
      this._emit("app.error", { source: "ServerFileTransferService", message: "inbound index upsert failed", severity: "warn", err });
    });
    if (indexRecord && this.bus.services && this.bus.services.threads) {
      this.bus.services.threads.emitThreadIndexUpdated(indexRecord);
    }

    this._emit("message.deposited", new MessageDepositedEvent({
      threadId: resolvedThreadId,
      message: {
        messageId,
        threadId: resolvedThreadId,
        senderAccountId: resolvedSender || null,
        text: captionText,
        payload: imagePayload,
        status: "delivered",
        createdAtMs: now,
        acceptedAtMs: now,
        packetB64: JSON.stringify(imagePayload.toJSON()),
      },
    }));
    this._emit("runtime.event.message.deposited", new MessageDepositedEvent({
      threadId: resolvedThreadId,
      message: {
        messageId,
        threadId: resolvedThreadId,
        senderAccountId: resolvedSender || null,
        text: captionText,
        payload: imagePayload,
        status: "delivered",
        createdAtMs: now,
        acceptedAtMs: now,
        packetB64: JSON.stringify(imagePayload.toJSON()),
      },
    }));
  }
}
