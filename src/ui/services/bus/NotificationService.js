import { BaseBusService } from "./BaseBusService.js";
import { nonEmptyString } from "../../../records/index.js";
import { IMAGE_KIND } from "../../../records/payloads/index.js";

const ICON_URL = new URL(
  "../../../../../rez-ui/branding/filled-silhouette/rez-icon-mark-notification.png",
  import.meta.url
).href;

export class NotificationService extends BaseBusService {
  #permissionWarned;

  constructor({ bus, uiStateStore } = {}) {
    super({ bus });
    if (!uiStateStore || typeof uiStateStore.snapshot !== "function") {
      throw new Error("NotificationService requires uiStateStore");
    }
    this._uiStateStore = uiStateStore;
    this.#permissionWarned = false;

    // Request once at construction AND again on every unlock so the prompt
    // surfaces as early as the renderer can show it. Electron's renderer
    // usually returns "granted" silently.
    this.#requestPermission();
    this._listen("session.unlocked", () => this.#requestPermission());
    this._listen("runtime.event.message.deposited", (record) => this.#onMessageDeposited(record));
    this._listen("runtime.event.invite.received", () => this.#onInviteReceived());
  }

  #requestPermission() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted" || Notification.permission === "denied") return;
    Notification.requestPermission().catch((err) => {
      console.error("[NotificationService] requestPermission failed", err);
    });
  }

  // Live check; never cached. Constructor-time snapshot would lock the service
  // OFF until session.unlocked even if the platform later grants permission.
  #notificationsAllowed() {
    if (typeof Notification === "undefined") return false;
    const perm = Notification.permission;
    if (perm === "granted") return true;
    if (!this.#permissionWarned) {
      this.#permissionWarned = true;
      console.warn(
        "[NotificationService] desktop alerts suppressed: Notification.permission = '" + perm
        + "' (expected 'granted'). On Electron this usually means the renderer never received a permission grant from the main process."
      );
    }
    return false;
  }

  #isAppFocused() {
    const snap = this._uiStateStore.snapshot();
    return snap.focused === true && snap.visible === true;
  }

  #onMessageDeposited(record) {
    if (!this.#notificationsAllowed()) return;
    if (this.#isAppFocused()) return;
    if (!record || typeof record !== "object") return;

    const threadId = nonEmptyString(record.threadId);
    const message = record.message && typeof record.message === "object" ? record.message : null;
    if (!threadId || !message) return;

    const text = String(message.text || "").trim();
    const payload = message.payload && typeof message.payload === "object" ? message.payload : null;
    const isImage = payload && String(payload.kind || "") === IMAGE_KIND;
    const preview = text || (isImage ? "Sent an image" : "New message");

    this.#resolveThreadContext(threadId).then((ctx) => {
      this.#fireNotification({
        title: ctx.title || "Rez",
        body: preview,
        tag: "msg-" + threadId + "-" + Date.now(),
        threadId,
        icon: ctx.icon,
      });
    }).catch((err) => {
      console.error("[NotificationService] resolveThreadContext failed", err);
      this.#fireNotification({
        title: "Rez",
        body: preview,
        tag: "msg-" + threadId + "-" + Date.now(),
        threadId,
        icon: null,
      });
    });
  }

  #onInviteReceived() {
    if (!this.#notificationsAllowed()) return;
    if (this.#isAppFocused()) return;

    this.#fireNotification({
      title: "Rez",
      body: "New invite received",
      tag: "invite-" + Date.now(),
      threadId: null,
    });
  }

  async #resolveThreadContext(threadId) {
    const thread = await this.bus.call("threads", "get", { threadId });
    if (!thread) return { title: "Rez", icon: null };

    const peerId = String(thread.peerAccountId || "").trim();
    let contact = null;
    if (peerId) {
      try {
        contact = await this.bus.call("contacts", "get", { accountId: peerId });
      } catch (err) {
        console.error("[NotificationService] get contact failed", err);
      }
    }

    const title = this.bus.queries.threads.displayLabel(threadId) || "Rez";

    const avatarHash = contact && typeof contact.avatarFileHash === "string" ? contact.avatarFileHash : "";
    let icon = null;
    if (avatarHash) {
      try {
        const fileResult = await this.bus.call("file", "get", { fileHashHex: avatarHash });
        if (fileResult && typeof fileResult.fileDataB64 === "string" && fileResult.fileDataB64.length > 0) {
          const mime = fileResult.mimeType && fileResult.mimeType.length > 0 ? fileResult.mimeType : "image/jpeg";
          icon = "data:" + mime + ";base64," + fileResult.fileDataB64;
        }
      } catch (err) {
        console.error("[NotificationService] fetch avatar for notification failed", err);
      }
    }

    return { title, icon };
  }

  #fireNotification({ title, body, tag, threadId, icon }) {
    if (typeof Notification === "undefined") return;
    try {
      const notification = new Notification(title, {
        body,
        tag,
        icon: icon || ICON_URL,
        silent: false,
      });
      notification.onclick = () => {
        try {
          if (typeof window !== "undefined" && window.focus) window.focus();
          if (threadId) {
            this.bus.call("threads", "select", { threadId }).catch((err) => {
              console.error("[NotificationService] select thread failed", err);
            });
          }
        } catch (err) {
          console.error("[NotificationService] notification click handler failed", err);
        }
      };
    } catch (err) {
      console.error("[NotificationService] failed to create notification", err);
    }
  }
}
