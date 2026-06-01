import { h } from "@rezprotocol/ui";
import { BusComponent } from "../base/BusComponent.js";
import { materialIcon } from "../base/icon.js";
import { ChatHeaderView } from "./ChatHeaderView.js";
import { MessageTimelineView } from "./MessageTimelineView.js";
import { ComposerView } from "./ComposerView.js";

export class ThreadPanelView extends BusComponent {
  #header;
  #timeline;
  #composer;
  #dropOverlayEl;
  #dragDepth;
  #dragHandlers;

  constructor({ bus } = {}) {
    super({ bus });
    this.#header = null;
    this.#timeline = null;
    this.#composer = null;
    this.#dropOverlayEl = null;
    this.#dragDepth = 0;
    this.#dragHandlers = null;
  }

  mount(parentEl) {
    super.mount(parentEl);
    if (!this._rootEl) return;
    // Ensure the overlay can position absolutely against the panel root.
    const rootClassName = this._rootEl.className || "";
    if (rootClassName.indexOf("relative") < 0) {
      this._rootEl.className = (rootClassName + " relative").trim();
    }
    const headerSlot = h("div", { className: "z-10 shrink-0" }, []);
    const timelineSlot = h("div", {
      className: "flex-1 min-h-0 overflow-y-auto custom-scrollbar p-space-lg space-y-8 chat-canvas-recessed",
    }, []);
    const composerSlot = h("footer", { className: "p-space-lg bg-surface-dim/80 backdrop-blur-md shrink-0 z-20" }, []);
    const dropOverlay = h("div", {
      className: "hidden absolute inset-0 z-30 pointer-events-none flex items-center justify-center bg-primary/15 backdrop-blur-sm border-2 border-dashed border-primary/60 rounded-lg",
      "data-testid": "thread-panel.drop-overlay",
    }, [
      h("div", {
        className: "flex flex-col items-center gap-2 text-primary",
      }, [
        materialIcon("upload_file", { size: 48 }),
        h("p", { className: "text-label-technical font-label-technical uppercase tracking-[0.15em]" }, "Drop file to attach"),
      ]),
    ]);
    this._rootEl.replaceChildren(headerSlot, timelineSlot, composerSlot, dropOverlay);
    this.#dropOverlayEl = dropOverlay;
    this.#header = new ChatHeaderView({ bus: this.bus });
    this.#header.mount(headerSlot);
    this.#timeline = new MessageTimelineView({ bus: this.bus });
    this.#timeline.mount(timelineSlot);
    this.#composer = new ComposerView({ bus: this.bus });
    this.#composer.mount(composerSlot);
    this.#wireDragDrop();
  }

  #wireDragDrop() {
    const root = this._rootEl;
    if (!root) return;
    const hasFiles = (evt) => {
      const dt = evt.dataTransfer;
      if (!dt) return false;
      const types = dt.types;
      if (!types) return false;
      // DOMStringList lacks .includes in older targets; use a loop.
      for (let i = 0; i < types.length; i++) {
        if (types[i] === "Files") return true;
      }
      return false;
    };
    const onDragEnter = (evt) => {
      if (!hasFiles(evt)) return;
      evt.preventDefault();
      this.#dragDepth += 1;
      this.#showOverlay();
    };
    const onDragOver = (evt) => {
      if (!hasFiles(evt)) return;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (evt) => {
      if (!hasFiles(evt)) return;
      evt.preventDefault();
      this.#dragDepth -= 1;
      if (this.#dragDepth <= 0) {
        this.#dragDepth = 0;
        this.#hideOverlay();
      }
    };
    const onDrop = (evt) => {
      if (!hasFiles(evt)) return;
      evt.preventDefault();
      this.#dragDepth = 0;
      this.#hideOverlay();
      const files = evt.dataTransfer && evt.dataTransfer.files ? evt.dataTransfer.files : null;
      if (!files || files.length === 0) return;
      // Single-file staging matches the composer's single-attachment model.
      const file = files[0];
      if (this.#composer && typeof this.#composer.stageFile === "function") {
        this.#composer.stageFile(file);
      }
    };
    root.addEventListener("dragenter", onDragEnter);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    this.#dragHandlers = { onDragEnter, onDragOver, onDragLeave, onDrop };
  }

  #showOverlay() {
    if (!this.#dropOverlayEl) return;
    this.#dropOverlayEl.classList.remove("hidden");
  }

  #hideOverlay() {
    if (!this.#dropOverlayEl) return;
    this.#dropOverlayEl.classList.add("hidden");
  }

  unmount() {
    if (this._rootEl && this.#dragHandlers) {
      this._rootEl.removeEventListener("dragenter", this.#dragHandlers.onDragEnter);
      this._rootEl.removeEventListener("dragover", this.#dragHandlers.onDragOver);
      this._rootEl.removeEventListener("dragleave", this.#dragHandlers.onDragLeave);
      this._rootEl.removeEventListener("drop", this.#dragHandlers.onDrop);
      this.#dragHandlers = null;
    }
    if (this.#header) { this.#header.unmount(); this.#header = null; }
    if (this.#timeline) { this.#timeline.unmount(); this.#timeline = null; }
    if (this.#composer) { this.#composer.unmount(); this.#composer = null; }
    this.#dropOverlayEl = null;
    this.#dragDepth = 0;
    super.unmount();
  }
}
