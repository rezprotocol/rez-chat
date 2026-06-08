import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ContactAvatarView } from "./ContactAvatarView.js";
import { avatarHue, shortId } from "../presenters/labels.js";
import { IMAGE_KIND } from "../../records/payloads/index.js";
import { tokenizeText, extractUrls } from "../presenters/linkify.js";

function openExternal(url) {
  const desktop = typeof window !== "undefined" && window.rezDesktop ? window.rezDesktop : null;
  if (desktop && typeof desktop.openExternal === "function") {
    desktop.openExternal(url).catch(() => {});
    return;
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname || "";
  } catch {
    return "";
  }
}

function buildLinkifiedChildren(text, { anchorClass } = {}) {
  const tokens = tokenizeText(text);
  if (tokens.length === 0) return [text];
  return tokens.map((tok) => {
    if (tok.type === "text") return tok.value;
    const a = h("a", {
      href: tok.url,
      target: "_blank",
      rel: "noopener noreferrer",
      className: anchorClass || "underline underline-offset-2 break-all",
      "data-testid": "message.link",
    }, tok.label);
    a.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openExternal(tok.url);
    });
    return a;
  });
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😢", "🙏"];

function formatTime(ms) {
  if (!ms || !Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function deliveryState(status) {
  const s = String(status || "").trim();
  if (s === "failed") return { label: "FAILED — TAP TO RETRY", icon: "error", iconClass: "text-error", title: "Failed — tap to retry" };
  if (s === "pending") return { label: "SENDING", icon: "schedule", iconClass: "text-primary-fixed/50", title: "" };
  if (s === "queued") return { label: "QUEUED", icon: "schedule", iconClass: "text-tertiary-fixed-dim", title: "Waiting for recipient — will deliver when they're online." };
  if (s === "sent") return { label: "SENT", icon: "done", iconClass: "text-primary-fixed/50", title: "" };
  return { label: "DELIVERED", icon: "done_all", iconClass: "text-primary-fixed/50", title: "" };
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function triggerDownload({ fileName, mimeType, fileDataB64 }) {
  const binary = atob(fileDataB64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || "file";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openLightbox(dataUrl, altText) {
  const backdrop = h("div", {
    className: "fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out",
  }, [
    h("img", {
      src: dataUrl,
      alt: altText || "Image",
      className: "max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl object-contain",
    }),
  ]);
  function dismiss() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(evt) {
    if (evt.key === "Escape") dismiss();
  }
  backdrop.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
}

export class MessageBubbleView extends BusComponent {
  #imageCache;
  #avatarView;
  #editing;
  #showingReactionPicker;

  constructor({ bus, threadId, messageId } = {}) {
    super({ bus });
    this._threadId = String(threadId || "").trim();
    this._messageId = String(messageId || "").trim();
    this._groupId = "";
    this.#imageCache = new Map();
    this.#avatarView = null;
    this.#editing = false;
    this.#showingReactionPicker = false;
  }

  get messageId() {
    return this._messageId;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    if (stores.messages) {
      this._subscribe(stores.messages, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (keys.threadId && keys.threadId !== this._threadId) return;
        if (type === "messages.upserted" && keys.messageId && keys.messageId !== this._messageId) return;
        this.render();
      });
    }
    if (stores.contacts) {
      this._subscribe(stores.contacts, () => this.render());
    }
    if (stores.groups) {
      this._subscribe(stores.groups, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (type === "groupMembers.replaced") {
          if (this._groupId && keys.groupId && keys.groupId !== this._groupId) return;
        }
        this.render();
      });
    }
    this.render();
  }

  render() {
    if (!this._rootEl) return;
    const stores = this.bus.stores || {};
    const message = stores.messages ? stores.messages.getMessage(this._threadId, this._messageId) : null;
    const thread = stores.threads ? stores.threads.getThread(this._threadId) : null;
    if (!message || !thread) {
      this._rootEl.replaceChildren();
      return;
    }
    this._groupId = thread.groupId ? String(thread.groupId) : "";
    const speakerId = String(message.speakerId || "").trim();
    const queries = this.bus.queries || {};
    const isMine = (queries.messages ? queries.messages.isOwnMessage(this._threadId, this._messageId) : false)
      && message.inferredNotMine !== true;
    const label = queries.messages.senderLabel(this._threadId, this._messageId)
      || (speakerId ? shortId(speakerId, 12) : "Account");
    const payload = message.payload && typeof message.payload === "object" ? message.payload : null;
    const isTombstoned = !!message.tombstonedAtMs;
    const isAttachment = !isTombstoned && payload && typeof payload.kind === "string" && payload.kind === IMAGE_KIND && typeof payload.fileHashHex === "string" && payload.fileHashHex.length > 0;
    const payloadMime = isAttachment && typeof payload.mimeType === "string" ? payload.mimeType : "";
    const isImage = isAttachment && payloadMime.toLowerCase().startsWith("image/");
    const rawText = String(message.text || message.preview || "").trim();
    const text = isTombstoned
      ? ""
      : (rawText || (isAttachment ? "" : "(encrypted)"));
    const time = formatTime(message.sentAtMs || message.createdAtMs);
    const editedSuffix = message.editedAtMs ? " (edited)" : "";

    const buildClickableImage = (dataUrl, altText) => {
      const img = h("img", {
        src: dataUrl,
        className: "max-w-[300px] rounded-lg cursor-pointer",
        alt: altText,
      });
      img.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openLightbox(dataUrl, altText);
      });
      return img;
    };

    const renderImageEl = (containerEl) => {
      if (!isImage) return;
      const hashHex = payload.fileHashHex;
      const altText = payload.fileName || "Image";
      const cached = this.#imageCache.get(hashHex);
      if (cached) {
        containerEl.prepend(h("div", {
          className: "max-w-[300px] rounded-lg overflow-hidden mb-2",
        }, [buildClickableImage(cached, altText)]));
        return;
      }
      const imgContainer = h("div", {
        className: "max-w-[300px] rounded-lg overflow-hidden bg-surface-container-lowest flex items-center justify-center min-h-[60px] mb-2",
      }, [h("p", { className: "text-label-micro text-outline font-label-technical p-2" }, "Loading…")]);
      containerEl.prepend(imgContainer);
      const stamp = this._messageId;
      this.bus.call("file", "get", { fileHashHex: hashHex }).then((result) => {
        if (this._messageId !== stamp || !this._rootEl) return;
        if (result && result.fileDataB64 && result.fileDataB64.length > 0) {
          const mimeStr = (result.mimeType && result.mimeType.length > 0) ? result.mimeType : (payload.mimeType || "image/png");
          const dataUrl = "data:" + mimeStr + ";base64," + result.fileDataB64;
          this.#imageCache.set(hashHex, dataUrl);
          imgContainer.replaceChildren(buildClickableImage(dataUrl, altText));
        } else {
          imgContainer.replaceChildren(h("p", { className: "text-label-micro text-outline font-label-technical p-2" }, "Image unavailable"));
        }
      }).catch(() => {
        if (!this._rootEl) return;
        const fallback = this.#imageCache.get(hashHex);
        if (fallback) {
          imgContainer.replaceChildren(buildClickableImage(fallback, altText));
        } else {
          imgContainer.replaceChildren(h("p", { className: "text-label-micro text-outline font-label-technical p-2" }, "Image unavailable"));
        }
      });
    };

    const renderDocEl = (containerEl, isMine) => {
      if (!isAttachment || isImage) return;
      const hashHex = payload.fileHashHex;
      const fileName = payload.fileName || "file";
      const sizeStr = formatBytes(payload.fileSizeBytes);
      const accentClass = isMine ? "text-on-primary/80" : "text-on-surface-variant";
      const nameClass = isMine ? "text-white font-medium" : "text-on-surface font-medium";
      const subClass = isMine ? "text-white/70" : "text-on-surface-variant";
      const chipBg = isMine ? "bg-on-primary/10 border-on-primary/20" : "bg-surface-container border-outline-variant/30";
      const iconWrap = h("div", {
        className: "w-10 h-10 rounded-md flex items-center justify-center shrink-0 " + (isMine ? "bg-on-primary/15" : "bg-surface-container-high"),
      }, [materialIcon("description", { size: 22, className: accentClass })]);
      const stateLabel = h("span", { className: "text-label-micro font-label-technical uppercase tracking-[0.1em] " + subClass }, sizeStr || "FILE");
      const downloadBtn = h("button", {
        type: "button",
        className: "shrink-0 w-8 h-8 flex items-center justify-center rounded-md transition-colors " + (isMine ? "hover:bg-on-primary/15 text-on-primary" : "hover:bg-primary/15 text-on-surface-variant hover:text-primary"),
        title: "Download " + fileName,
        "aria-label": "Download " + fileName,
        "data-testid": "message.attachment.download",
      }, [materialIcon("download", { size: 20 })]);
      let downloading = false;
      downloadBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (downloading) return;
        downloading = true;
        const iconHolder = downloadBtn.firstChild;
        downloadBtn.replaceChildren(materialIcon("hourglass_empty", { size: 20 }));
        this.bus.call("file", "get", { fileHashHex: hashHex }).then((result) => {
          downloading = false;
          downloadBtn.replaceChildren(iconHolder);
          if (!result || !result.fileDataB64 || result.fileDataB64.length === 0) {
            stateLabel.textContent = "UNAVAILABLE";
            return;
          }
          triggerDownload({
            fileName,
            mimeType: payload.mimeType || "application/octet-stream",
            fileDataB64: result.fileDataB64,
          });
        }).catch(() => {
          downloading = false;
          downloadBtn.replaceChildren(iconHolder);
          stateLabel.textContent = "UNAVAILABLE";
        });
      });
      const chip = h("div", {
        className: "max-w-[320px] flex items-center gap-3 px-3 py-2 mb-2 rounded-lg border " + chipBg,
        "data-testid": "message.attachment.doc",
      }, [
        iconWrap,
        h("div", { className: "flex flex-col min-w-0 flex-1" }, [
          h("span", { className: "text-body-sm truncate " + nameClass, title: fileName }, fileName),
          stateLabel,
        ]),
        downloadBtn,
      ]);
      containerEl.prepend(chip);
    };

    const renderAttachmentEl = (containerEl, isMine) => {
      if (!isAttachment) return;
      if (isImage) renderImageEl(containerEl);
      else renderDocEl(containerEl, isMine);
    };

    const replyHeaderEl = this.#buildReplyHeader(message, isMine);
    const reactionsRowEl = isTombstoned ? null : this.#buildReactionsRow(message, isMine);
    const actionsEl = isTombstoned ? null : this.#buildActionMenu(message, isMine);

    if (isMine) {
      const state = deliveryState(message.status);
      const bubbleChildren = [];
      if (replyHeaderEl) bubbleChildren.push(replyHeaderEl);
      if (this.#editing && !isTombstoned) {
        bubbleChildren.push(this.#buildEditForm(message));
      } else if (isTombstoned) {
        bubbleChildren.push(h("p", { className: "text-body-base italic text-on-primary/60 break-words", "data-testid": "message.tombstoned" }, "[deleted]"));
      } else if (text) {
        bubbleChildren.push(h("p", {
          className: "text-body-base font-medium text-white break-words [overflow-wrap:anywhere]",
          "data-testid": "message.text",
        }, buildLinkifiedChildren(text, { anchorClass: "underline underline-offset-2 break-all text-white" })));
      }
      if (time) {
        bubbleChildren.push(h("span", { className: "block text-left text-label-micro text-white/60 font-label-technical mt-2" }, time + editedSuffix));
      }
      const bubbleEl = h("div", {
        className: isTombstoned
          ? "p-4 rounded-2xl rounded-br-none bg-surface-container/60 border border-outline-variant/30 text-on-surface-variant relative overflow-hidden max-w-full min-w-0"
          : "chat-bubble-out p-4 rounded-2xl rounded-br-none text-white relative overflow-hidden max-w-full min-w-0",
        "data-testid": "message.bubble",
        "data-message-mine": "true",
        "data-message-tombstoned": isTombstoned ? "true" : "false",
      }, bubbleChildren);
      if (!isTombstoned && !this.#editing) renderAttachmentEl(bubbleEl, true);
      if (!isTombstoned && text) this.#renderLinkPreview(bubbleEl, text, true);
      const isFailed = !isTombstoned && String(message.status || "").trim() === "failed";
      const statusRowClass = isFailed
        ? "flex items-center gap-2 text-label-micro text-error font-label-technical cursor-pointer hover:underline"
        : "flex items-center gap-2 text-label-micro text-primary-fixed/50 font-label-technical";
      const statusRowAttrs = {
        className: statusRowClass,
        "data-testid": "message.status",
        "data-message-status": String(message.status || "").trim() || "delivered",
      };
      if (state.title) statusRowAttrs.title = state.title;
      const statusRow = isTombstoned ? null : h("div", statusRowAttrs, [
        h("span", null, state.label),
        materialIcon(state.icon, { size: 14, className: state.iconClass }),
      ]);
      if (statusRow && isFailed) {
        statusRow.setAttribute("role", "button");
        statusRow.setAttribute("aria-label", "Retry sending message");
        statusRow.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.bus.call("messages", "send", {
            threadId: this._threadId,
            messageId: this._messageId,
          });
        });
      }
      const innerCol = h("div", { className: "flex flex-col items-end gap-3 max-w-[80%] min-w-0 w-fit group/message relative" }, [
        bubbleEl,
        reactionsRowEl,
        statusRow,
      ]);
      if (actionsEl) innerCol.appendChild(actionsEl);
      const outerEl = h("div", { className: "flex justify-end w-full" }, [innerCol]);
      this._rootEl.replaceChildren(outerEl);
      return;
    }

    const hue = avatarHue(label);
    const senderColor = "hsl(" + hue + ", 70%, 65%)";
    const otherBubbleChildren = [];
    if (replyHeaderEl) otherBubbleChildren.push(replyHeaderEl);
    if (isTombstoned) {
      otherBubbleChildren.push(h("p", { className: "text-body-base italic text-on-surface-variant/60 break-words", "data-testid": "message.tombstoned" }, "[deleted]"));
    } else if (text) {
      otherBubbleChildren.push(h("p", {
        className: "text-body-base text-on-surface break-words [overflow-wrap:anywhere]",
        "data-testid": "message.text",
      }, buildLinkifiedChildren(text, { anchorClass: "underline underline-offset-2 break-all text-primary" })));
    }
    if (time) {
      otherBubbleChildren.push(h("span", { className: "block text-right text-label-micro text-outline-variant font-label-technical mt-2" }, time + editedSuffix));
    }
    const otherBubbleEl = h("div", {
      className: isTombstoned
        ? "p-4 rounded-2xl rounded-bl-none bg-surface-container/60 border border-outline-variant/30 text-on-surface-variant relative overflow-hidden max-w-full min-w-0"
        : "chat-bubble-in p-4 rounded-2xl rounded-bl-none relative overflow-hidden max-w-full min-w-0",
      "data-testid": "message.bubble",
      "data-message-mine": "false",
      "data-message-tombstoned": isTombstoned ? "true" : "false",
    }, otherBubbleChildren);
    if (!isTombstoned) renderAttachmentEl(otherBubbleEl, false);
    if (!isTombstoned && text) this.#renderLinkPreview(otherBubbleEl, text, false);

    const contactAvatarHash = stores.contacts.getAvatarHash(speakerId);
    const avatarSlot = h("div", { className: "w-8 h-8 rounded-md overflow-hidden" });
    if (this.#avatarView) {
      this.#avatarView.unmount();
    }
    this.#avatarView = new ContactAvatarView({
      bus: this.bus,
      label,
      fileHashHex: contactAvatarHash,
      sizeClass: "w-full h-full",
      roundedClass: "rounded-md",
    });

    const senderLabelEl = thread.threadType === "group"
      ? h("p", { className: "text-label-micro font-label-technical uppercase tracking-[0.1em] ml-1", style: { color: senderColor } }, label)
      : null;

    const innerRow = h("div", { className: "flex items-end gap-3 max-w-[80%] min-w-0 w-fit group/message relative" }, [
      h("div", { className: "shrink-0 mb-1" }, [avatarSlot]),
      h("div", { className: "flex flex-col gap-1 min-w-0" }, [
        senderLabelEl,
        otherBubbleEl,
        reactionsRowEl,
      ]),
    ]);
    if (actionsEl) innerRow.appendChild(actionsEl);
    const outerEl = h("div", { className: "flex justify-start w-full" }, [innerRow]);
    this._rootEl.replaceChildren(outerEl);
    this.#avatarView.mount(avatarSlot);
  }

  // Append an OpenGraph card under `bubbleEl` for the first http(s) URL in
  // `text`. Card starts as a thin loading skeleton; populates in-place when
  // LinksService resolves. Re-renders are cheap — LinksService de-duplicates
  // by URL and returns synchronously from its in-memory cache after the
  // first resolve.
  #renderLinkPreview(bubbleEl, text, isMine) {
    const urls = extractUrls(text);
    const url = urls.length > 0 ? urls[0] : "";
    if (!url) return;
    const linksService = this.bus.services && this.bus.services.links ? this.bus.services.links : null;
    if (!linksService) return;
    const card = h("div", {
      className: "link-preview mt-2 rounded-lg overflow-hidden bg-surface-container/40 border border-outline-variant/30 max-w-[400px]",
      "data-testid": "message.link.preview",
      "data-link-url": url,
    }, []);
    bubbleEl.appendChild(card);
    const renderInto = (preview) => {
      if (!preview || preview.error) {
        card.remove();
        return;
      }
      const titleText = String(preview.title || preview.canonicalUrl || preview.url || "").trim();
      const descText = String(preview.description || "").trim();
      const siteText = String(preview.siteName || hostnameOf(preview.canonicalUrl || preview.url)).trim();
      const imgUrl = String(preview.imageDataUrl || "").trim();
      const children = [];
      if (imgUrl) {
        children.push(h("img", {
          src: imgUrl,
          alt: titleText || "Preview",
          className: "block w-full max-h-[200px] object-cover bg-surface-container-lowest",
        }));
      }
      const meta = [];
      if (siteText) {
        meta.push(h("p", {
          className: (isMine ? "text-on-primary/70" : "text-on-surface-variant/70")
            + " text-label-micro font-label-technical uppercase tracking-[0.08em] truncate",
        }, siteText));
      }
      if (titleText) {
        meta.push(h("p", {
          className: (isMine ? "text-white" : "text-on-surface")
            + " text-body-sm font-medium leading-snug line-clamp-2 break-words",
        }, titleText));
      }
      if (descText) {
        meta.push(h("p", {
          className: (isMine ? "text-white/80" : "text-on-surface-variant")
            + " text-body-sm leading-snug line-clamp-3 break-words",
        }, descText));
      }
      if (meta.length > 0) {
        children.push(h("div", { className: "p-3 flex flex-col gap-1" }, meta));
      }
      card.replaceChildren(...children);
      card.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        openExternal(preview.canonicalUrl || preview.url || url);
      });
      card.style.cursor = "pointer";
    };
    const synchronous = linksService.getPreview({ url });
    if (synchronous && synchronous.status === "resolved" && synchronous.preview) {
      renderInto(synchronous.preview);
      return;
    }
    if (synchronous && synchronous.status === "error") {
      card.remove();
      return;
    }
    const messageStamp = this._messageId;
    linksService.unfurl({ url }).then((entry) => {
      if (this._messageId !== messageStamp || !this._rootEl) return;
      if (!card.isConnected) return;
      if (entry && entry.preview && !entry.error) renderInto(entry.preview);
      else card.remove();
    }).catch((err) => {
      console.warn("[MessageBubbleView] unfurl failed", err && err.message ? err.message : err);
      if (card.isConnected) card.remove();
    });
  }

  #buildReplyHeader(message, isMine) {
    const targetId = String(message.inReplyToMessageId || "").trim();
    if (!targetId) return null;
    const stores = this.bus.stores || {};
    const target = stores.messages ? stores.messages.getMessage(this._threadId, targetId) : null;
    const preview = target && typeof target.text === "string" && target.text
      ? target.text.slice(0, 80)
      : "(message)";
    const senderLabel = target && target.senderAccountId ? target.senderAccountId.slice(-6) : "";
    return h("div", {
      className: "reply-block",
      "data-testid": "message.replyHeader",
    }, [
      h("div", { className: "reply-accent" }),
      h("div", { className: "px-2 py-1 min-w-0 flex-1" }, [
        h("p", { className: "text-label-micro font-label-technical uppercase tracking-[0.1em] text-primary" }, "REPLY" + (senderLabel ? " · " + senderLabel : "")),
        h("p", { className: "text-body-sm font-body-sm truncate text-white/90" }, preview),
      ]),
    ]);
  }

  #buildReactionsRow(message, isMine) {
    const reactions = message.reactions && typeof message.reactions === "object" ? message.reactions : {};
    const entries = Object.keys(reactions);
    if (entries.length === 0) return null;
    // Reactions are keyed by the peerlink/chat-server account id (the same id
    // group membership and message authorship use), not the vault account id.
    const selfAccountId = this.bus.stores.session.chatAccountId() || "";
    const row = h("div", {
      className: "flex flex-wrap gap-1 " + (isMine ? "justify-end" : "justify-start") + " mt-1",
      "data-testid": "message.reactions",
    }, []);
    for (const emoji of entries) {
      const senders = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
      if (senders.length === 0) continue;
      const mine = selfAccountId && senders.indexOf(selfAccountId) >= 0;
      const chip = h("button", {
        className: "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-body-sm font-label-technical "
          + (mine
            ? "bg-primary/20 border-primary/60 text-primary"
            : "bg-surface-container border-outline-variant/30 text-on-surface-variant hover:bg-surface-container-high"),
        type: "button",
        title: senders.join(", "),
        "data-emoji": emoji,
      }, [
        h("span", {}, emoji),
        h("span", { className: "text-label-micro" }, String(senders.length)),
      ]);
      chip.addEventListener("click", () => {
        const op = mine ? "removeReaction" : "addReaction";
        this.bus.call("messages", op, {
          threadId: this._threadId,
          targetMessageId: this._messageId,
          emoji,
        });
      });
      row.appendChild(chip);
    }
    if (row.childNodes.length === 0) return null;
    return row;
  }

  #buildActionMenu(message, isMine) {
    const wrap = h("div", {
      className: "opacity-0 group-hover/message:opacity-100 transition-opacity absolute "
        + (isMine ? "left-0 -translate-x-full pr-2 top-0" : "right-0 translate-x-full pl-2 top-0")
        + " flex gap-1 items-start",
      "data-testid": "message.actions",
    }, []);

    const iconButton = (iconName, title, testId, danger = false) => {
      const btn = h("button", {
        type: "button",
        className: (danger
          ? "w-7 h-7 flex items-center justify-center rounded bg-surface-container-high/90 border border-outline-variant/30 hover:bg-error/30 text-on-surface-variant hover:text-error transition-colors"
          : "w-7 h-7 flex items-center justify-center rounded bg-surface-container-high/90 border border-outline-variant/30 hover:bg-primary/15 text-on-surface-variant hover:text-primary transition-colors"),
        title,
        "aria-label": title,
        "data-testid": testId,
      }, [materialIcon(iconName, { size: 14 })]);
      return btn;
    };

    const replyBtn = iconButton("reply", "Reply", "message.action.reply");
    replyBtn.addEventListener("click", () => {
      this.bus.call("messages", "setReplyDraft", {
        threadId: this._threadId,
        targetMessageId: this._messageId,
      });
    });
    wrap.appendChild(replyBtn);

    const reactBtn = iconButton("mood", "React", "message.action.react");
    reactBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.#showingReactionPicker = !this.#showingReactionPicker;
      this.render();
    });
    wrap.appendChild(reactBtn);

    if (this.#showingReactionPicker) {
      const picker = h("div", {
        className: "flex gap-1 bg-surface-container-high/95 border border-outline-variant/30 rounded-md px-1 py-0.5",
        "data-testid": "message.reactionPicker",
      }, QUICK_REACTIONS.map((emoji) => {
        const btn = h("button", {
          className: "w-6 h-6 flex items-center justify-center rounded hover:bg-primary/15 text-body-base",
          type: "button",
          "data-emoji": emoji,
        }, emoji);
        btn.addEventListener("click", () => {
          this.#showingReactionPicker = false;
          this.bus.call("messages", "addReaction", {
            threadId: this._threadId,
            targetMessageId: this._messageId,
            emoji,
          });
        });
        return btn;
      }));
      wrap.appendChild(picker);
    }

    if (isMine) {
      const editBtn = iconButton("edit", "Edit", "message.action.edit");
      editBtn.addEventListener("click", () => {
        this.#editing = true;
        this.render();
      });
      wrap.appendChild(editBtn);

      const deleteEveryoneBtn = iconButton("delete", "Delete for everyone", "message.action.deleteEveryone", true);
      deleteEveryoneBtn.addEventListener("click", () => {
        this.bus.call("messages", "deleteMessage", {
          threadId: this._threadId,
          targetMessageId: this._messageId,
          scope: "everyone",
        });
      });
      wrap.appendChild(deleteEveryoneBtn);
    }

    const deleteForMeBtn = iconButton("close", "Delete for me", "message.action.deleteForMe", true);
    deleteForMeBtn.addEventListener("click", () => {
      this.bus.call("messages", "deleteMessage", {
        threadId: this._threadId,
        targetMessageId: this._messageId,
        scope: "me",
      });
    });
    wrap.appendChild(deleteForMeBtn);

    return wrap;
  }

  #buildEditForm(message) {
    const wrap = h("div", { className: "flex flex-col gap-2", "data-testid": "message.editForm" });
    const input = h("input", {
      type: "text",
      className: "bg-on-primary/10 border border-on-primary/30 rounded px-2 py-1 text-body-base text-on-primary font-body-base w-72",
      value: typeof message.text === "string" ? message.text : "",
    });
    const row = h("div", { className: "flex gap-2 justify-end" }, []);
    const cancel = h("button", {
      type: "button",
      className: "text-label-micro font-label-technical px-2 py-1 rounded border border-on-primary/30 hover:bg-on-primary/10 text-on-primary/80",
    }, "CANCEL");
    cancel.addEventListener("click", () => {
      this.#editing = false;
      this.render();
    });
    const save = h("button", {
      type: "button",
      className: "text-label-micro font-label-technical px-2 py-1 rounded bg-on-primary text-primary",
    }, "SAVE");
    const doSave = () => {
      const next = String(input.value || "").trim();
      if (!next) return;
      const same = String(message.text || "") === next;
      this.#editing = false;
      if (same) {
        this.render();
        return;
      }
      this.bus.call("messages", "edit", {
        threadId: this._threadId,
        targetMessageId: this._messageId,
        newText: next,
      });
    };
    save.addEventListener("click", doSave);
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") { evt.preventDefault(); doSave(); }
      else if (evt.key === "Escape") { this.#editing = false; this.render(); }
    });
    row.appendChild(cancel);
    row.appendChild(save);
    wrap.appendChild(input);
    wrap.appendChild(row);
    queueMicrotask(() => { if (input.isConnected) input.focus(); });
    return wrap;
  }

  unmount() {
    if (this.#avatarView) {
      this.#avatarView.unmount();
      this.#avatarView = null;
    }
    super.unmount();
  }
}
