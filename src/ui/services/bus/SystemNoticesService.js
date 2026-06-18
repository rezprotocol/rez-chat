import { BaseBusService } from "./BaseBusService.js";
import { ChatThread } from "../../../records/index.js";
import { SYSTEM_NOTICES_THREAD_ID, isSystemNoticesThreadId } from "../../system/systemNoticesThread.js";

// Owns the synthetic, UI-only "System" thread end-to-end: it consumes runtime
// quarantine events into NoticesStore and keeps a single ChatThread row in
// ThreadStore in sync (so the thread-list row, unread badge, and archive status
// all reuse the existing thread machinery). The synthetic thread has no server
// counterpart, so its archive state is owned here (a local UI status), it is
// read-only (sendAllowed:false), and the header gates Delete off for it.
export class SystemNoticesService extends BaseBusService {
  #noticesStore;
  #threadStore;
  #uiStateStore;
  #archived;

  constructor({ bus, noticesStore, threadStore, uiStateStore } = {}) {
    super({ bus });
    if (!noticesStore || !threadStore || !uiStateStore) {
      throw new Error("SystemNoticesService requires noticesStore, threadStore, uiStateStore");
    }
    this.#noticesStore = noticesStore;
    this.#threadStore = threadStore;
    this.#uiStateStore = uiStateStore;
    this.#archived = false;

    // Local-only archive toggle (no server thread exists to call thread.state.set
    // on). ChatHeaderView routes the System thread's archive button here.
    this._register("systemNotices", "setArchived", (payload) => this.setArchived(payload));

    // A quarantined deposit could not be decrypted — it has no thread, sender, or
    // content — so it is surfaced here instead of being silently dropped.
    this._listen("runtime.event.mailbox.deposit.quarantined", (record) => this.#onQuarantined(record));

    // ThreadsService.ensureList({force}) calls ThreadStore.replaceThreads on every
    // reconnect, which wipes the synthetic row. Re-inject it after a replace/reset.
    const offThreads = threadStore.onChange((evt) => {
      const type = evt && typeof evt.type === "string" ? evt.type : "";
      if (type === "threads.replaced" || type === "threads.reset") this.#refreshThread();
    });
    this._offs.push(offThreads);

    // Opening the System thread acknowledges its notices (clears the badge).
    const offUi = uiStateStore.onChange((evt) => {
      const type = evt && typeof evt.type === "string" ? evt.type : "";
      if (type === "ui.selectedThread.changed") this.#onSelectionChanged();
    });
    this._offs.push(offUi);
  }

  setArchived({ archived } = {}) {
    const next = archived === true;
    if (this.#archived === next) return { archived: this.#archived };
    this.#archived = next;
    // Mirror ThreadsService.archive: leaving the conversation when archiving.
    if (next && this.#isSelected()) {
      this.#uiStateStore.setSelectedThreadId(null);
    }
    this.#refreshThread();
    return { archived: this.#archived };
  }

  #isSelected() {
    if (typeof this.#uiStateStore.snapshot !== "function") return false;
    const snap = this.#uiStateStore.snapshot();
    return isSystemNoticesThreadId(snap ? snap.selectedThreadId : null);
  }

  #onQuarantined(record) {
    const entry = this.#noticesStore.addNotice(record, Date.now());
    if (!entry) return;
    // A notice arriving while the thread is already open is read on arrival.
    if (this.#isSelected()) this.#noticesStore.markRead();
    this.#refreshThread();
  }

  #onSelectionChanged() {
    if (!this.#isSelected()) return;
    this.#noticesStore.markRead();
    this.#refreshThread();
  }

  #refreshThread() {
    if (this.#noticesStore.size() === 0) {
      // No notices this session → no System thread at all (don't show an empty one).
      this.#threadStore.removeThread(SYSTEM_NOTICES_THREAD_ID);
      return;
    }
    const latest = this.#noticesStore.latest();
    const lastActivityAtMs = latest ? latest.receivedAtMs : 0;
    const thread = new ChatThread({
      threadId: SYSTEM_NOTICES_THREAD_ID,
      threadType: "direct",
      title: "System",
      displayTitle: "System",
      visibilityState: this.#archived ? "hidden" : "visible",
      accessState: "open",
      threadReady: true,
      sendAllowed: false,
      unreadCount: this.#noticesStore.unreadCount(),
      lastActivityAtMs,
      lastMessagePreview: "A message couldn't be delivered",
    });
    this.#threadStore.upsertThread(thread);
    this.bus.emit("threads.updated", { threadId: SYSTEM_NOTICES_THREAD_ID });
  }
}
