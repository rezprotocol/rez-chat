import { BaseBusService } from "./BaseBusService.js";
import { ChatMessage, nonEmptyString } from "../../../records/index.js";
import { MESSAGE_KIND } from "../../../records/payloads/index.js";

export class MessagesService extends BaseBusService {
  constructor({ bus, messageStore } = {}) {
    super({ bus });
    if (!messageStore) throw new Error("MessagesService requires messageStore");
    this._messageStore = messageStore;
    this._replyDrafts = new Map();
    this._register("messages", "ensureList", (payload) => this.ensureList(payload));
    this._register("messages", "getIds", (payload) => this.getIds(payload));
    this._register("messages", "get", (payload) => this.get(payload));
    this._register("messages", "send", (payload) => this.send(payload));
    this._register("messages", "sendImage", (payload) => this.sendImage(payload));
    this._register("messages", "edit", (payload) => this.editMessage(payload));
    this._register("messages", "deleteMessage", (payload) => this.deleteMessage(payload));
    this._register("messages", "addReaction", (payload) => this.addReaction(payload));
    this._register("messages", "removeReaction", (payload) => this.removeReaction(payload));
    this._register("messages", "setReplyDraft", (payload) => this.setReplyDraft(payload));
    this._register("messages", "getReplyDraft", (payload) => this.getReplyDraft(payload));
    this._register("file", "get", (payload) => this.getFile(payload));
    this._listen("runtime.event.message.deposited", (record) => this._handleDeposited(record));
    this._listen("runtime.event.message.status", (record) => this._handleStatus(record));
    this._listen("runtime.event.message.updated", (record) => this._handleUpdated(record));
    this._listen("runtime.event.message.removed", (record) => this._handleRemoved(record));
  }

  _getClient() {
    return this.bus.runtime && this.bus.runtime.client ? this.bus.runtime.client : null;
  }

  _createMessageId(threadId) {
    const prefix = "msgcli_" + Date.now().toString(36);
    const cleanThreadId = nonEmptyString(threadId).replace(/[^a-zA-Z0-9_-]/g, "").slice(-12);
    const cryptoObj = globalThis && globalThis.crypto && typeof globalThis.crypto === "object"
      ? globalThis.crypto
      : null;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      const uuid = cryptoObj.randomUUID().replace(/-/g, "");
      return cleanThreadId ? `${prefix}_${cleanThreadId}_${uuid}` : `${prefix}_${uuid}`;
    }
    const randomPart = Math.random().toString(36).slice(2, 12);
    return cleanThreadId ? `${prefix}_${cleanThreadId}_${randomPart}` : `${prefix}_${randomPart}`;
  }

  async ensureList({ threadId, limit = 50, before = null, force = false } = {}) {
    const id = nonEmptyString(threadId);
    const client = this._getClient();
    if (!id || !client) return [];
    if (!force && before == null && this._messageStore.isLoaded(id)) {
      return this._messageStore.getMessages(id);
    }
    const result = await client.call("thread.messages.list", { threadId: id, limit, before });
    const items = result && Array.isArray(result.items) ? result.items : [];
    if (before == null) {
      this._messageStore.replaceMessages(id, items);
    } else {
      for (const item of items) {
        this._messageStore.upsertMessage(id, item);
      }
      this._messageStore.markLoaded(id, true);
    }
    this.bus.emit("messages.updated", { threadId: id });
    return this._messageStore.getMessages(id);
  }

  getIds({ threadId } = {}) {
    return this._messageStore.getMessageIds(threadId);
  }

  get({ threadId, messageId } = {}) {
    return this._messageStore.getMessage(threadId, messageId);
  }

  _getSelfAccountId() {
    const sessionStore = this.bus.stores && this.bus.stores.session ? this.bus.stores.session : null;
    if (!sessionStore || typeof sessionStore.snapshot !== "function") return "";
    const snap = sessionStore.snapshot() || {};
    return nonEmptyString(snap.accountId);
  }

  async send({ threadId, text, channelId = "", messageId = "" } = {}) {
    const id = nonEmptyString(threadId);
    const client = this._getClient();
    if (!id || !client) return null;
    // Resend path: messageId of an existing (typically failed) row. Reuse
    // its payload as fresh truth; reset status to pending. The server's
    // sendMessage is idempotent on messageId — same row gets re-driven.
    const resendId = nonEmptyString(messageId);
    const existing = resendId ? this._messageStore.getMessage(id, resendId) : null;
    const isResend = !!existing;
    const body = isResend
      ? (typeof existing.text === "string" ? existing.text : "")
      : (typeof text === "string" ? text.trim() : "");
    if (!isResend && !body) return null;
    const useMessageId = isResend ? existing.messageId : this._createMessageId(id);
    const selfAccountId = this._getSelfAccountId();
    const existingPayload = isResend && existing.payload && typeof existing.payload === "object" ? existing.payload : null;
    const inReplyToMessageId = isResend
      ? (existingPayload && typeof existingPayload.inReplyToMessageId === "string" ? existingPayload.inReplyToMessageId : "")
      : (this._replyDrafts.get(id) || "");
    const ch = isResend
      ? (existingPayload && typeof existingPayload.channelId === "string" ? existingPayload.channelId : "")
      : (typeof channelId === "string" ? channelId.trim() : "");
    const nowMs = Date.now();
    let payload;
    if (isResend && existingPayload) {
      payload = { ...existingPayload };
    } else {
      payload = inReplyToMessageId
        ? { kind: MESSAGE_KIND, text: body, inReplyToMessageId }
        : { kind: MESSAGE_KIND, text: body };
      if (ch) payload.channelId = ch;
    }
    const optimisticBase = isResend ? existing.toJSON() : {
      threadId: id,
      messageId: useMessageId,
      senderAccountId: selfAccountId,
      speakerId: selfAccountId,
      text: body,
      payload,
      createdAtMs: nowMs,
      acceptedAtMs: nowMs,
      inReplyToMessageId,
    };
    const optimistic = new ChatMessage({
      ...optimisticBase,
      status: "pending",
    });
    this._messageStore.upsertMessage(id, optimistic);
    this.bus.emit("messages.updated", { threadId: id, messageId: useMessageId });
    if (!isResend && inReplyToMessageId) {
      this._replyDrafts.delete(id);
      this.bus.emit("messages.replyDraft.updated", { threadId: id, inReplyToMessageId: "" });
    }
    let result;
    try {
      result = await client.sendRezPayload({
        threadId: id,
        payload,
        messageId: useMessageId,
        channelId: ch,
      });
    } catch (err) {
      this._messageStore.updateStatus(id, useMessageId, { status: "failed" });
      this.bus.emit("messages.updated", { threadId: id, messageId: useMessageId });
      throw err;
    }
    const acceptedAtMs = Number(result && result.acceptedAtMs ? result.acceptedAtMs : nowMs);
    // With sender-stable messageId, result.messageId === messageId; the
    // optimistic row already exists under this id. Just bump status.
    if (result && result.messageId === useMessageId) {
      this._messageStore.updateStatus(id, useMessageId, {
        status: "sent",
        acceptedAtMs,
        sentAtMs: acceptedAtMs,
      });
      this.bus.emit("messages.updated", { threadId: id, messageId: useMessageId });
    }
    return result;
  }

  async sendImage({ threadId, fileDataB64, fileName, mimeType, text, channelId } = {}) {
    const id = nonEmptyString(threadId);
    const client = this._getClient();
    if (!id || !client) return null;
    return client.call("file.send", { threadId: id, fileDataB64, fileName, mimeType, text, channelId });
  }

  async getFile({ fileHashHex } = {}) {
    const client = this._getClient();
    if (!client) return null;
    return client.call("file.get", { fileHashHex });
  }

  _handleDeposited(record) {
    const id = nonEmptyString(record && record.threadId);
    const message = record && record.message ? record.message : null;
    if (!id || !message) return;
    this._messageStore.upsertMessage(id, message);
    this.bus.emit("messages.updated", { threadId: id });
  }

  _handleStatus(record) {
    const id = nonEmptyString(record && record.threadId);
    const messageId = nonEmptyString(record && record.messageId);
    if (!id || !messageId) return;
    const current = this._messageStore.getMessage(id, messageId);
    if (!current) return;
    this._messageStore.upsertMessage(id, new ChatMessage({
      ...current.toJSON(),
      status: record && record.status ? record.status : current.status,
      sentAtMs: record && record.sentAtMs != null ? record.sentAtMs : current.sentAtMs,
    }));
    this.bus.emit("messages.updated", { threadId: id, messageId });
  }

  _handleUpdated(record) {
    const id = nonEmptyString(record && record.threadId);
    const message = record && record.message ? record.message : null;
    if (!id || !message) return;
    this._messageStore.upsertMessage(id, message);
    const messageId = nonEmptyString(message.messageId);
    this.bus.emit("messages.updated", messageId ? { threadId: id, messageId } : { threadId: id });
  }

  _handleRemoved(record) {
    const id = nonEmptyString(record && record.threadId);
    const messageId = nonEmptyString(record && record.messageId);
    if (!id || !messageId) return;
    this._messageStore.removeMessage(id, messageId);
    this.bus.emit("messages.updated", { threadId: id, messageId });
  }

  async editMessage({ threadId, targetMessageId, newText } = {}) {
    const id = nonEmptyString(threadId);
    const target = nonEmptyString(targetMessageId);
    const client = this._getClient();
    if (!id || !target || !client) return null;
    return client.call("message.edit", { threadId: id, targetMessageId: target, newText: typeof newText === "string" ? newText : "" });
  }

  async deleteMessage({ threadId, targetMessageId, scope = "everyone" } = {}) {
    const id = nonEmptyString(threadId);
    const target = nonEmptyString(targetMessageId);
    const client = this._getClient();
    if (!id || !target || !client) return null;
    if (scope === "me") {
      return client.call("message.deleteLocal", { threadId: id, targetMessageId: target });
    }
    return client.call("message.tombstone", { threadId: id, targetMessageId: target });
  }

  async addReaction({ threadId, targetMessageId, emoji } = {}) {
    const id = nonEmptyString(threadId);
    const target = nonEmptyString(targetMessageId);
    const e = nonEmptyString(emoji);
    const client = this._getClient();
    if (!id || !target || !e || !client) return null;
    return client.call("message.reaction.add", { threadId: id, targetMessageId: target, emoji: e });
  }

  async removeReaction({ threadId, targetMessageId, emoji } = {}) {
    const id = nonEmptyString(threadId);
    const target = nonEmptyString(targetMessageId);
    const e = nonEmptyString(emoji);
    const client = this._getClient();
    if (!id || !target || !e || !client) return null;
    return client.call("message.reaction.remove", { threadId: id, targetMessageId: target, emoji: e });
  }

  setReplyDraft({ threadId, targetMessageId } = {}) {
    const id = nonEmptyString(threadId);
    if (!id) return null;
    const target = nonEmptyString(targetMessageId);
    if (target) {
      this._replyDrafts.set(id, target);
    } else {
      this._replyDrafts.delete(id);
    }
    this.bus.emit("messages.replyDraft.updated", { threadId: id, inReplyToMessageId: target });
    return { threadId: id, inReplyToMessageId: target };
  }

  getReplyDraft({ threadId } = {}) {
    const id = nonEmptyString(threadId);
    if (!id) return "";
    return this._replyDrafts.get(id) || "";
  }
}
