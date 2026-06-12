import { nonEmptyString } from "../../records/index.js";
import { ContactQueries } from "./ContactQueries.js";
import { GroupQueries } from "./GroupQueries.js";

/**
 * ThreadQueries: cross-store thread-domain answers.
 *
 * Composes ContactQueries + GroupQueries internally (instantiated with
 * the same `stores`). Stateless.
 */
export class ThreadQueries {
  #stores;
  #contacts;
  #groups;

  constructor({ stores } = {}) {
    if (!stores) throw new Error("ThreadQueries requires { stores }");
    this.#stores = stores;
    this.#contacts = new ContactQueries({ stores });
    this.#groups = new GroupQueries({ stores });
  }

  #selfChatAccountId() {
    const session = this.#stores.session;
    if (!session || typeof session.chatAccountId !== "function") return null;
    return session.chatAccountId();
  }

  #thread(threadId) {
    const threads = this.#stores.threads;
    if (!threads || typeof threads.getThread !== "function") return null;
    return threads.getThread(threadId);
  }

  // Currently-selected thread id. UiStateStore is the SSOT; this is a
  // typed read so views can ask the thread-domain queries object instead
  // of reaching into UiStateStore.
  selectedThreadId() {
    const ui = this.#stores.uiState;
    if (!ui || typeof ui.selectedThreadId !== "function") return null;
    return ui.selectedThreadId();
  }

  // Display label for a thread. Direct → peer's display name (Contact +
  // Session). Group → group title. Returns null when nothing better than
  // the raw id is known — pure display layer can fall back.
  displayLabel(threadId) {
    const thread = this.#thread(threadId);
    if (!thread) return null;
    if (thread.threadType === "group") {
      const groups = this.#stores.groups;
      const group = groups && typeof groups.getGroup === "function"
        ? groups.getGroup(thread.groupId)
        : null;
      if (group && nonEmptyString(group.title)) return group.title;
      if (nonEmptyString(thread.title)) return thread.title;
      return null;
    }
    // Direct thread: the title IS the peer's name, resolved from the ONE account
    // table by accountId — no per-thread title copy. Returns null (→ short-id in
    // the view) until the contact/known row is known, never a stale cached name.
    if (thread.peerAccountId) {
      const name = this.#contacts.displayName(thread.peerAccountId);
      if (name) return name;
    }
    return null;
  }

  // Member ids participating in a thread. Direct → [self, peer]. Group →
  // GroupStore.
  memberIds(threadId) {
    const thread = this.#thread(threadId);
    if (!thread) return [];
    if (thread.threadType === "group") {
      const groups = this.#stores.groups;
      if (groups && typeof groups.getMemberIds === "function") {
        return groups.getMemberIds(thread.groupId);
      }
      return [];
    }
    const out = [];
    const selfId = this.#selfChatAccountId();
    if (selfId) out.push(selfId);
    if (thread.peerAccountId && thread.peerAccountId !== selfId) {
      out.push(thread.peerAccountId);
    }
    return out;
  }

  // Any thread the store holds is readable. Locked direct threads are
  // still readable for history; the writable gate is separate.
  isReadableByMe(threadId) {
    return this.#thread(threadId) != null;
  }

  // Whether the composer should be enabled.
  isWritable(threadId) {
    const thread = this.#thread(threadId);
    if (!thread) return false;
    if (thread.accessState === "locked") return false;
    if (thread.threadType === "group") {
      const self = this.#groups.selfMember(thread.groupId);
      if (!self || self.state !== "active") return false;
    }
    return true;
  }

  // Per-thread display bundle. Pure formatting (status badges, peer-link
  // tone styling) lives in presenters; this query does the derivation.
  presentationContext(threadId) {
    const thread = this.#thread(threadId);
    if (!thread) return null;
    return {
      thread,
      threadReady: thread.threadReady === true,
      writable: this.isWritable(threadId),
      readable: this.isReadableByMe(threadId),
      label: this.displayLabel(threadId),
      memberIds: this.memberIds(threadId),
    };
  }
}
