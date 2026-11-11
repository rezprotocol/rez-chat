import { RRecord } from "@rezprotocol/sdk/client";
import { FileManifestV1, FileChunkV1 } from "@rezprotocol/sdk/filetransfer";
import { isValidChannelId } from "./ChatMessagePayloadV1.js";

// Chat owns the routing/application metadata around generic SDK file bytes.
// Existing wire kinds remain readable; absent messageEnvelope is legacy.
class ChatFileContextV1 extends RRecord {
  static type = "chat.file.context.v1";
  constructor(raw = {}) {
    super();
    this.threadId = typeof raw.threadId === "string" ? raw.threadId : "";
    this.senderAccountId = typeof raw.senderAccountId === "string" ? raw.senderAccountId : "";
    this.channelId = typeof raw.channelId === "string" ? raw.channelId : "";
    this.messageEnvelope = raw.messageEnvelope === true;
    this._seal();
  }
  validate() {
    this.assert(!this.channelId || isValidChannelId(this.channelId), "Invalid attachment channel");
  }
}

export class ChatFileManifestV1 extends RRecord {
  static type = "chat.file.manifest.v1";
  constructor(raw = {}) {
    super();
    this.manifest = raw instanceof FileManifestV1 ? raw : FileManifestV1.fromJSON(raw);
    this.context = new ChatFileContextV1(raw);
    this._seal();
  }
  toJSON() { return { ...this.manifest.toJSON(), ...this.context.toJSON() }; }
}

export class ChatFileChunkV1 extends RRecord {
  static type = "chat.file.chunk.v1";
  constructor(raw = {}) {
    super();
    this.chunk = raw instanceof FileChunkV1 ? raw : FileChunkV1.fromJSON(raw);
    this.context = new ChatFileContextV1(raw);
    this._seal();
  }
  toJSON() { return { ...this.chunk.toJSON(), ...this.context.toJSON() }; }
}
