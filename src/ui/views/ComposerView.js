import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";

const TEXTAREA_MAX_HEIGHT_PX = 200;

// Hard ceiling lines up with FileSendParams.fileDataB64 maxLength of 14M
// chars (≈10.5MB binary). Keeping the UI cap at 10MB binary leaves a small
// margin under the wire ceiling.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ACCEPT_ATTR = [
  "image/*",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/rtf",
  "application/zip",
].join(",");

function isImageMime(mime) {
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
}

function autoResize(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  textarea.style.height = "auto";
  const next = textarea.scrollHeight;
  textarea.style.height = next + "px";
  textarea.style.overflowY = next > TEXTAREA_MAX_HEIGHT_PX ? "auto" : "hidden";
}

export class ComposerView extends BusComponent {
  #staged;
  #inputEl;
  #sendBtnEl;
  #stateEl;
  #errorEl;
  #formEl;
  #attachBtnEl;
  #previewRowEl;
  #replyChipEl;
  #threadId;
  #disabled;
  #replyDraftOff;

  constructor({ bus } = {}) {
    super({ bus });
    this.#staged = null;
    this.#inputEl = null;
    this.#sendBtnEl = null;
    this.#stateEl = null;
    this.#errorEl = null;
    this.#formEl = null;
    this.#attachBtnEl = null;
    this.#previewRowEl = null;
    this.#replyChipEl = null;
    this.#threadId = "";
    this.#disabled = false;
    this.#replyDraftOff = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    const uiStateStore = this.bus.stores && this.bus.stores.uiState;
    if (uiStateStore) {
      this._subscribe(uiStateStore, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        if (type === "ui.selectedThread.changed") {
          this.#staged = null;
          this.render();
        }
      });
    }
    const threadStore = this.bus.stores && this.bus.stores.threads;
    if (threadStore) {
      this._subscribe(threadStore, (evt) => {
        const type = evt && typeof evt.type === "string" ? evt.type : "";
        const keys = evt && evt.keys ? evt.keys : {};
        if (type === "threads.upserted" && keys.threadId === this.#threadId) {
          this.#refreshDisabledState();
        } else if (type === "threads.replaced") {
          this.#refreshDisabledState();
        }
      });
    }
    this.#replyDraftOff = this.bus.on("messages.replyDraft.updated", (record) => {
      const recordThreadId = record && typeof record.threadId === "string" ? record.threadId : "";
      if (recordThreadId && recordThreadId === this.#threadId) {
        this.#renderReplyChip();
        const inReplyToMessageId = record && typeof record.inReplyToMessageId === "string"
          ? record.inReplyToMessageId.trim()
          : "";
        if (inReplyToMessageId && this.#inputEl && !this.#disabled) {
          this.#inputEl.focus();
        }
      }
    });
    this.render();
  }

  unmount() {
    if (typeof this.#replyDraftOff === "function") {
      this.#replyDraftOff();
      this.#replyDraftOff = null;
    }
    super.unmount();
  }

  render() {
    if (!this._rootEl) return;
    const threadId = this.#getSelectedThreadId();
    this.#buildForm(threadId);
  }

  #renderReplyChip() {
    const chip = this.#replyChipEl;
    if (!chip) return;
    const threadId = this.#threadId;
    const messagesService = this.bus.services && this.bus.services.messages
      ? this.bus.services.messages
      : null;
    const inReplyToMessageId = threadId && messagesService
      ? (messagesService.getReplyDraft({ threadId }) || "")
      : "";
    if (!inReplyToMessageId) {
      chip.className = "hidden";
      chip.replaceChildren();
      return;
    }
    const stores = this.bus.stores || {};
    const target = stores.messages ? stores.messages.getMessage(threadId, inReplyToMessageId) : null;
    const preview = target && typeof target.text === "string" && target.text
      ? target.text.slice(0, 80)
      : "(message)";
    const clearBtn = h("button", {
      className: "w-5 h-5 flex items-center justify-center rounded-full bg-surface-container-high hover:bg-error/30 text-on-surface-variant hover:text-on-surface transition-colors text-sm leading-none",
      type: "button",
      title: "Cancel reply",
    }, "×");
    clearBtn.addEventListener("click", () => {
      this.bus.call("messages", "setReplyDraft", { threadId, targetMessageId: "" });
    });
    chip.className = "flex items-center gap-3 px-3 py-1.5 mb-2 bg-surface-container border border-outline-variant/30 rounded-lg border-l-2 border-l-primary";
    chip.replaceChildren(
      h("span", { className: "text-label-micro font-label-technical text-primary/80 uppercase tracking-[0.1em]" }, "REPLY TO"),
      h("span", { className: "text-body-sm font-body-sm text-on-surface-variant truncate flex-1" }, preview),
      clearBtn,
    );
  }

  #getSelectedThreadId() {
    const queries = this.bus.queries;
    if (!queries || !queries.threads) return "";
    return queries.threads.selectedThreadId() || "";
  }

  #getSelectedChannelId(threadId) {
    if (!threadId) return "";
    const uiState = this.bus.stores && this.bus.stores.uiState;
    if (!uiState || typeof uiState.getSelectedChannelId !== "function") return "";
    return uiState.getSelectedChannelId(threadId) || "";
  }

  #getThread(threadId) {
    if (!threadId) return null;
    return this.bus.stores.threads.getThread(threadId);
  }

  #buildForm(threadId) {
    this.#threadId = threadId || "";

    const input = h("textarea", {
      className: "flex-1 bg-transparent border-none focus:ring-0 focus:outline-none text-body-base font-body-base text-on-surface py-3 resize-none custom-scrollbar placeholder:text-outline-variant",
      placeholder: "Type a secure message...",
      rows: "1",
      autocomplete: "off",
      "data-testid": "composer.input",
    });
    const stateEl = h("p", {
      className: "hidden text-label-micro font-label-technical text-error px-1 pt-1",
      "data-testid": "composer.state",
    }, "");
    const errorEl = h("p", {
      className: "hidden text-label-micro font-label-technical text-error px-1 pt-1",
      "data-testid": "composer.error",
    }, "");

    const attachBtn = h("button", {
      type: "button",
      className: "p-3 text-on-surface-variant hover:text-primary transition-colors",
      title: "Attach file",
      "aria-label": "Attach file",
    }, [materialIcon("add_circle")]);

    const moodBtn = h("button", {
      type: "button",
      className: "p-3 text-on-surface-variant hover:text-primary transition-colors",
      title: "Insert emoji",
      "aria-label": "Insert emoji",
    }, [materialIcon("mood")]);

    const sendBtn = h("button", {
      type: "button",
      className: "bg-primary-container text-on-primary-container p-3 rounded-xl hover:shadow-[0_0_20px_rgba(0,218,243,0.3)] transition-all active:scale-95",
      title: "Send",
      "aria-label": "Send message",
      "data-testid": "composer.send",
    }, [materialIcon("send")]);

    const previewRow = h("div", { className: "hidden" });
    this.#renderStagedPreview(previewRow);
    const replyChip = h("div", { className: "hidden" });
    this.#replyChipEl = replyChip;

    const form = h("div", {
      className: "input-tactile rounded-2xl border border-outline-variant/30 p-2 flex items-end gap-2 group focus-within:border-primary/40 transition-all",
    }, [attachBtn, input, moodBtn, sendBtn]);

    const footnote = h("p", {
      className: "text-center text-label-micro font-label-technical text-outline-variant mt-3 tracking-widest uppercase opacity-50",
    }, "End-to-End Encrypted via Reznet");

    const wrap = h("div", { className: "max-w-4xl mx-auto relative" }, [
      replyChip,
      previewRow,
      form,
      stateEl,
      errorEl,
      footnote,
    ]);

    this.#inputEl = input;
    this.#sendBtnEl = sendBtn;
    this.#stateEl = stateEl;
    this.#errorEl = errorEl;
    this.#formEl = form;
    this.#attachBtnEl = attachBtn;
    this.#previewRowEl = previewRow;

    this._rootEl.replaceChildren(wrap);

    input.addEventListener("input", () => autoResize(input));

    if (!threadId) {
      input.disabled = true;
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      this.#disabled = true;
      input.placeholder = "Select a conversation to send";
      return;
    }

    this.#applyThreadState(this.#getThread(threadId));
    this.#renderReplyChip();
    this.#wireActions(threadId);
  }

  #refreshDisabledState() {
    if (!this.#threadId || !this.#inputEl) return;
    this.#applyThreadState(this.#getThread(this.#threadId));
  }

  #applyThreadState(thread) {
    const input = this.#inputEl;
    const sendBtn = this.#sendBtnEl;
    const stateEl = this.#stateEl;
    const form = this.#formEl;
    const attachBtn = this.#attachBtnEl;
    if (!input || !sendBtn || !stateEl || !form || !attachBtn) return;

    const locked = String(thread && thread.accessState || "open").toLowerCase() === "locked";
    const ready = !!(thread && thread.threadReady !== false);
    const sendAllowed = !thread || thread.sendAllowed !== false;
    const disabled = locked || !ready || !sendAllowed;
    this.#disabled = disabled;

    input.disabled = disabled;
    sendBtn.disabled = disabled;
    attachBtn.disabled = disabled;
    if (disabled) {
      input.placeholder = locked ? "Thread is locked" : !ready ? "Thread not ready" : "Sending disabled";
      stateEl.textContent = locked
        ? "THREAD LOCKED — sending is disabled."
        : !ready
          ? "THREAD NOT READY — conversation bootstrap is incomplete."
          : "SERVER STATE DISALLOWS SENDING IN THIS THREAD.";
      stateEl.classList.remove("hidden");
      form.className = "input-tactile rounded-2xl border border-error/40 p-2 flex items-end gap-2";
      sendBtn.className = "bg-surface-container-high text-on-surface-variant p-3 rounded-xl cursor-not-allowed opacity-60";
    } else {
      input.placeholder = "Type a secure message...";
      stateEl.classList.add("hidden");
      stateEl.textContent = "";
      form.className = "input-tactile rounded-2xl border border-outline-variant/30 p-2 flex items-end gap-2 group focus-within:border-primary/40 transition-all";
      sendBtn.className = "bg-primary-container text-on-primary-container p-3 rounded-xl hover:shadow-[0_0_20px_rgba(0,218,243,0.3)] transition-all active:scale-95";
    }
  }

  #wireActions(threadId) {
    const input = this.#inputEl;
    const sendBtn = this.#sendBtnEl;
    const errorEl = this.#errorEl;
    const previewRow = this.#previewRowEl;
    const attachBtn = this.#attachBtnEl;
    if (!input || !sendBtn || !errorEl || !previewRow || !attachBtn) return;

    attachBtn.addEventListener("click", () => {
      this.#pickFile(errorEl, previewRow);
    });

    const send = () => {
      const text = String(input.value || "").trim();
      if (this.#staged) {
        const attachment = this.#staged;
        this.#staged = null;
        this.#renderStagedPreview(previewRow);
        const channelId = this.#getSelectedChannelId(threadId);
        this.bus.call("messages", "sendImage", {
          threadId,
          fileDataB64: attachment.fileDataB64,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          text,
          channelId,
        }).then(() => {
          input.value = "";
          autoResize(input);
          errorEl.classList.add("hidden");
          errorEl.textContent = "";
          input.focus();
        }).catch((err) => {
          errorEl.textContent = err && err.message ? err.message : "Unable to send file.";
          errorEl.classList.remove("hidden");
          input.focus();
        });
        return;
      }
      if (!text) return;
      const channelId = this.#getSelectedChannelId(threadId);
      this.bus.call("messages", "send", { threadId, text, channelId }).then(() => {
        input.value = "";
        autoResize(input);
        errorEl.classList.add("hidden");
        errorEl.textContent = "";
        input.focus();
      }).catch((err) => {
        errorEl.textContent = err && err.message ? err.message : "Unable to send.";
        errorEl.classList.remove("hidden");
        input.focus();
      });
    };
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
  }

  #pickFile(errorEl, previewRow) {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ACCEPT_ATTR;
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      if (file) this.#stageFromFile(file, errorEl, previewRow);
    });
    document.body.appendChild(fileInput);
    fileInput.click();
    document.body.removeChild(fileInput);
  }

  // Public entry point used by ThreadPanelView's drag/drop handler. Returns
  // true if the file was accepted for staging (even though the read is async),
  // false if it was rejected synchronously (composer disabled, no thread,
  // missing refs).
  stageFile(file) {
    if (!(file instanceof File) && !(file instanceof Blob)) return false;
    if (this.#disabled || !this.#threadId) return false;
    const errorEl = this.#errorEl;
    const previewRow = this.#previewRowEl;
    if (!errorEl || !previewRow) return false;
    this.#stageFromFile(file, errorEl, previewRow);
    return true;
  }

  #stageFromFile(file, errorEl, previewRow) {
    if (file.size > MAX_FILE_BYTES) {
      const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
      errorEl.textContent = "File too large (max " + mb + "MB).";
      errorEl.classList.remove("hidden");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result;
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const fileDataB64 = btoa(binary);
      const mimeType = file.type || "application/octet-stream";
      const isImage = isImageMime(mimeType);
      this.#staged = {
        fileDataB64,
        fileName: file.name || "file",
        mimeType,
        fileSizeBytes: file.size,
        isImage,
        thumbUrl: isImage ? "data:" + mimeType + ";base64," + fileDataB64 : "",
      };
      errorEl.classList.add("hidden");
      errorEl.textContent = "";
      this.#renderStagedPreview(previewRow);
    };
    reader.onerror = () => {
      errorEl.textContent = "Failed to read file.";
      errorEl.classList.remove("hidden");
    };
    reader.readAsArrayBuffer(file);
  }

  #renderStagedPreview(previewRow) {
    if (!this.#staged) {
      previewRow.className = "hidden";
      previewRow.replaceChildren();
      return;
    }
    const leading = this.#staged.isImage
      ? h("img", {
          src: this.#staged.thumbUrl,
          className: "h-16 w-16 rounded-lg border border-outline-variant/30 object-cover shrink-0",
          alt: this.#staged.fileName,
        })
      : h("div", {
          className: "h-16 w-16 rounded-lg border border-outline-variant/30 bg-surface-container-high flex items-center justify-center text-on-surface-variant shrink-0",
        }, [materialIcon("description", { size: 28 })]);
    const sizeLabel = formatFileSize(this.#staged.fileSizeBytes);
    const labelStack = h("div", { className: "flex flex-col min-w-0" }, [
      h("span", {
        className: "text-label-technical font-label-technical text-on-surface truncate max-w-[240px]",
      }, this.#staged.fileName),
      sizeLabel ? h("span", {
        className: "text-label-micro font-label-technical text-on-surface-variant",
      }, sizeLabel) : null,
    ]);
    const removeBtn = h("button", {
      className: "w-5 h-5 flex items-center justify-center rounded-full bg-surface-container-high hover:bg-error/30 text-on-surface-variant hover:text-on-surface transition-colors text-sm leading-none shrink-0",
      type: "button",
      title: "Remove attachment",
    }, "×");
    removeBtn.addEventListener("click", () => {
      this.#staged = null;
      this.#renderStagedPreview(previewRow);
    });
    previewRow.className = "flex items-center gap-3 px-3 py-1.5 mb-2 bg-surface-container border border-outline-variant/30 rounded-lg";
    previewRow.replaceChildren(leading, labelStack, removeBtn);
  }
}

function formatFileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
