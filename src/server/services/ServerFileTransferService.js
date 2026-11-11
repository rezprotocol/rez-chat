import { FileTransferService } from "@rezprotocol/sdk/filetransfer";
import { base64ToBytes, bytesToBase64 } from "@rezprotocol/sdk/client";
import { Hash } from "@rezprotocol/sdk/hash";
import { FileSendParams, FileSendResult, FileGetParams, FileGetResult } from "../../records/index.js";
import { ChatFileManifestV1, ChatFileChunkV1 } from "../../records/payloads/ChatFilePayloadsV1.js";
import { FILE_MANIFEST_KIND } from "../../records/payloads/index.js";
import { BaseServerService } from "../base/BaseServerService.js";

// Byte transfer/cache only. Message creation, projection, status and receipts
// belong to ServerMessagesService and ServerEventService for every media kind.
export class ServerFileTransferService extends BaseServerService {
  #kvStore;
  #fileTransferService = null;
  #sendContext = null;
  #sendTail = Promise.resolve();

  constructor({ bus, storageProvider, ownerAccountId, logger = console } = {}) {
    super({ bus, ownerAccountId, logger });
    if (!storageProvider || typeof storageProvider.getKeyValueStore !== "function") throw new Error("ServerFileTransferService requires storageProvider");
    this.#kvStore = storageProvider.getKeyValueStore("app:filetransfer");
    this._register("file", "get", (payload) => this.getFile(payload));
  }

  async storeFile(fileHashHex, fileDataB64) {
    if (typeof fileHashHex !== "string" || !fileHashHex.trim()) {
      throw new Error("storeFile requires fileHashHex");
    }
    if (typeof fileDataB64 !== "string" || !fileDataB64) {
      throw new Error("storeFile requires fileDataB64");
    }
    const claimed = fileHashHex.trim();
    // TRUST-2: the store is content-addressed by hash, so we CAN verify the bytes
    // match the key — therefore we always do. Without this a peer could store
    // arbitrary bytes under another file's hash and poison the content-addressed
    // store (every consumer addresses by the authenticated payload.fileHashHex).
    let actual;
    try {
      actual = Hash.sha256Hex(base64ToBytes(fileDataB64));
    } catch (err) {
      throw new Error("storeFile: undecodable fileDataB64");
    }
    if (actual !== claimed) {
      throw new Error("storeFile: content does not match fileHashHex (rejected)");
    }
    await this.#kvStore.set("file:" + claimed, fileDataB64);
  }

  async retrieveFileB64(fileHashHex) {
    if (typeof fileHashHex !== "string" || !fileHashHex.trim()) return null;
    const key = fileHashHex.trim();
    const b64 = await this.#kvStore.get("file:" + key);
    if (typeof b64 !== "string") return null;
    // TRUST-2 (read side): re-verify the stored bytes against the content address
    // every time. Cheap, and it makes the store self-validating regardless of how
    // an entry was written (defends against local-state corruption too).
    let actual;
    try {
      actual = Hash.sha256Hex(base64ToBytes(b64));
    } catch (err) {
      return null;
    }
    return actual === key ? b64 : null;
  }

  async start() {
    const sdk = this.bus.runtime ? this.bus.runtime.sdk : null;
    if (!sdk || typeof sdk.sealForPeer !== "function" || !sdk.mesh) throw new Error("ServerFileTransferService requires sdk with sealForPeer + mesh");
    this.#fileTransferService = new FileTransferService({
      log: this.logger, kvStore: this.#kvStore,
      onSendDeposit: async ({ contextId, plaintextBodyBytes }) => {
        const raw = JSON.parse(new TextDecoder().decode(plaintextBodyBytes));
        const input = { ...raw, threadId: contextId, senderAccountId: this.ownerAccountId,
          channelId: this.#sendContext.channelId, messageEnvelope: true };
        const payload = raw.kind === FILE_MANIFEST_KIND ? new ChatFileManifestV1(input) : new ChatFileChunkV1(input);
        const bytes = new TextEncoder().encode(JSON.stringify(payload.toJSON()));
        await this.bus.services.messages.dispatchThreadBytes(contextId, bytes, "file:" + Hash.sha256Hex(bytes));
      },
      onFileReceived: ({ manifest, senderAccountId, contextId }) =>
        this.bus.services.messages.handleFileBytesReceived(manifest, senderAccountId, contextId),
    });
  }

  async sendFileBytes(payload) {
    const params = this._coerceParams(payload, FileSendParams);
    const pending = this.#sendTail.then(async () => {
      this.#sendContext = params;
      try {
        const fileBytes = base64ToBytes(params.fileDataB64);
        const result = await this.#fileTransferService.sendFile({
          fileBytes, fileName: params.fileName,
          mimeType: params.mimeType, peerAccountId: this.ownerAccountId, contextId: params.threadId,
        });
        return new FileSendResult({ threadId: params.threadId, fileHashHex: result.manifest.fileHashHex, fileSizeBytes: fileBytes.length, transferId: result.transferId });
      } finally { this.#sendContext = null; }
    });
    this.#sendTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async hasFile(fileHashHex, fileSizeBytes) {
    const bytes = await this.#fileTransferService.getFile(fileHashHex);
    return Boolean(bytes && bytes.length === fileSizeBytes);
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

  async handleIncomingPayload(payload, { senderAccountId, threadId } = {}) {
    if (!this.#fileTransferService) return false;
    const record = payload instanceof ChatFileManifestV1 ? payload.manifest
      : payload instanceof ChatFileChunkV1 ? payload.chunk : payload;
    return this.#fileTransferService.handleIncomingPayload(record, { senderAccountId, contextId: threadId });
  }
}
