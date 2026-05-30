import { ContactQueries } from "./ContactQueries.js";

/**
 * MessageQueries: cross-store message-domain answers (own-message check
 * + sender label). Channel-filtered timeline is an own-data MessageStore
 * accessor, not a query.
 */
export class MessageQueries {
  #stores;
  #contacts;

  constructor({ stores } = {}) {
    if (!stores) throw new Error("MessageQueries requires { stores }");
    this.#stores = stores;
    this.#contacts = new ContactQueries({ stores });
  }

  #message(threadId, messageId) {
    const messages = this.#stores.messages;
    if (!messages || typeof messages.getMessage !== "function") return null;
    return messages.getMessage(threadId, messageId);
  }

  // True when the message was sent by the current self. Checks both
  // speakerId and senderAccountId — wire-side messages can be credited
  // under either depending on the code path that constructed them.
  isOwnMessage(threadId, messageId) {
    const msg = this.#message(threadId, messageId);
    if (!msg) return false;
    const session = this.#stores.session;
    if (!session || typeof session.isSelf !== "function") return false;
    if (msg.speakerId && session.isSelf(msg.speakerId)) return true;
    if (msg.senderAccountId && session.isSelf(msg.senderAccountId)) return true;
    return false;
  }

  // Label to display for a message's sender. Order: self → "You", contact
  // displayName, group member displayName (when the thread is a group and
  // the speaker is a known member), else null.
  senderLabel(threadId, messageId) {
    const msg = this.#message(threadId, messageId);
    if (!msg) return null;
    const speakerId = msg.speakerId || msg.senderAccountId;
    if (!speakerId) return null;
    const direct = this.#contacts.displayName(speakerId);
    if (direct) return direct;
    const threads = this.#stores.threads;
    const thread = threads && typeof threads.getThread === "function"
      ? threads.getThread(threadId) : null;
    if (thread && thread.groupId) {
      const groups = this.#stores.groups;
      if (groups && typeof groups.getMember === "function") {
        const member = groups.getMember(thread.groupId, speakerId);
        if (member && member.displayName) return member.displayName;
      }
    }
    return null;
  }
}
