import { h } from "@rezprotocol/ui";

// Self-contained emoji picker (no external dependency). A curated set of common
// emoji grouped into categories; the tab strip switches the visible grid.
// Selecting an emoji invokes `onSelect(emoji)` — the caller owns insertion.
const EMOJI_CATEGORIES = [
  {
    id: "smileys",
    tab: "😀",
    label: "Smileys",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃",
      "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙",
      "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔",
      "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥",
      "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮",
      "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐",
      "😕", "😟", "🙁", "😮", "😯", "😲", "😳", "🥺", "😦", "😧",
      "😨", "😰", "😥", "😢", "😭", "😱", "😖", "😣", "😞", "😓",
      "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "😈", "👿", "💀",
      "🤡", "👻", "👽", "🤖", "💩",
    ],
  },
  {
    id: "gestures",
    tab: "👋",
    label: "People",
    emojis: [
      "👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞",
      "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎",
      "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🙏", "✍️",
      "💅", "🤳", "💪", "🦾", "🧠", "🫀", "👀", "👁️", "👅", "👄",
      "👶", "🧒", "👦", "👧", "🧑", "👨", "👩", "🧓", "👴", "👵",
      "🙇", "🤦", "🤷", "🙆", "🙅", "💁", "🙋", "🧏", "🤝", "👫",
    ],
  },
  {
    id: "hearts",
    tab: "❤️",
    label: "Hearts",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔",
      "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "♥️",
      "💯", "💢", "💥", "💫", "💦", "💨", "🕳️", "💬", "💭", "💤",
    ],
  },
  {
    id: "animals",
    tab: "🐶",
    label: "Animals",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
      "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐔", "🐧",
      "🐦", "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐗", "🐴", "🦄",
      "🐝", "🐛", "🦋", "🐌", "🐞", "🐜", "🕷️", "🦂", "🐢", "🐍",
      "🦎", "🐙", "🦑", "🦐", "🦀", "🐡", "🐠", "🐟", "🐬", "🐳",
      "🐋", "🦈", "🐊", "🐅", "🐆", "🦓", "🦍", "🐘", "🦏", "🐪",
      "🌵", "🌲", "🌳", "🌴", "🌱", "🌿", "🍀", "🍁", "🍂", "🍃",
      "🌷", "🌹", "🌺", "🌸", "🌼", "🌻", "⭐", "🌟", "🌞", "🌝",
    ],
  },
  {
    id: "food",
    tab: "🍔",
    label: "Food",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐",
      "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🥑", "🍆", "🥔",
      "🥕", "🌽", "🌶️", "🥒", "🥬", "🥦", "🧄", "🧅", "🍄", "🥜",
      "🍞", "🥐", "🥖", "🥨", "🧀", "🥚", "🍳", "🧇", "🥓", "🥩",
      "🍗", "🍖", "🌭", "🍔", "🍟", "🍕", "🥪", "🌮", "🌯", "🥗",
      "🍝", "🍜", "🍲", "🍛", "🍣", "🍱", "🥟", "🍤", "🍙", "🍚",
      "🍦", "🍰", "🎂", "🍮", "🍭", "🍬", "🍫", "🍿", "🍩", "🍪",
      "☕", "🍵", "🧃", "🥤", "🍺", "🍻", "🥂", "🍷", "🥃", "🍸",
    ],
  },
  {
    id: "activities",
    tab: "⚽",
    label: "Activities",
    emojis: [
      "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱",
      "🏓", "🏸", "🥅", "🏒", "🏑", "🥍", "🏏", "⛳", "🏹", "🎣",
      "🥊", "🥋", "🎽", "⛸️", "🥌", "🛷", "🎿", "⛷️", "🏂", "🏋️",
      "🤼", "🤸", "🤺", "🤾", "🏌️", "🏇", "🧘", "🏄", "🏊", "🚴",
      "🎯", "🎮", "🕹️", "🎲", "🎰", "🧩", "🎭", "🎨", "🎬", "🎤",
      "🎧", "🎼", "🎹", "🥁", "🎷", "🎺", "🎸", "🎻", "🏆", "🥇",
    ],
  },
  {
    id: "travel",
    tab: "🌍",
    label: "Travel",
    emojis: [
      "🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐",
      "🚚", "🚛", "🚜", "🛵", "🏍️", "🚲", "🛴", "🚂", "🚆", "🚇",
      "✈️", "🛫", "🛬", "🚀", "🛸", "🚁", "⛵", "🚤", "🛳️", "⚓",
      "🌍", "🌎", "🌏", "🗺️", "🏔️", "⛰️", "🌋", "🏖️", "🏝️", "🏜️",
      "🏕️", "🏠", "🏡", "🏢", "🏰", "🗼", "🗽", "🌉", "🎡", "🎢",
      "🌅", "🌄", "🌠", "🎇", "🎆", "🌈", "☀️", "🌤️", "⛅", "🌧️",
    ],
  },
  {
    id: "objects",
    tab: "💡",
    label: "Objects",
    emojis: [
      "⌚", "📱", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "💽", "💾", "💿",
      "📷", "📸", "📹", "🎥", "📞", "☎️", "📟", "📠", "📺", "📻",
      "🔋", "🔌", "💡", "🔦", "🕯️", "🧯", "🛢️", "💸", "💵", "💴",
      "💰", "💳", "💎", "⚖️", "🔧", "🔨", "⚒️", "🛠️", "🔩", "⚙️",
      "🔫", "💣", "🔪", "🗡️", "⚔️", "🛡️", "🔑", "🗝️", "🚪", "🛋️",
      "📚", "📖", "📝", "✏️", "🖊️", "🖌️", "📌", "📎", "✂️", "📐",
      "📅", "📆", "📋", "📁", "🗂️", "🗃️", "🔍", "🔎", "🔐", "🔒",
    ],
  },
  {
    id: "symbols",
    tab: "✅",
    label: "Symbols",
    emojis: [
      "✅", "❌", "❎", "✔️", "☑️", "❓", "❔", "❗", "❕", "‼️",
      "⁉️", "⚠️", "🚫", "🔞", "📵", "🚭", "❇️", "✳️", "✴️", "🌐",
      "💠", "Ⓜ️", "🔱", "⚜️", "🔰", "♻️", "✨", "🎉", "🎊", "🎈",
      "🎁", "🏅", "🥈", "🥉", "🔥", "⭐", "🌟", "💫", "⚡", "☄️",
      "➕", "➖", "➗", "✖️", "♾️", "💲", "💱", "©️", "®️", "™️",
      "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "⚫", "⚪", "🟤", "🔺",
    ],
  },
];

export class EmojiPickerView {
  #onSelect;
  #rootEl;
  #gridEl;
  #tabEls;
  #open;
  #anchorEl;
  #onDocPointerDown;
  #onKeyDown;

  constructor({ onSelect } = {}) {
    this.#onSelect = typeof onSelect === "function" ? onSelect : () => {};
    this.#open = false;
    this.#anchorEl = null;
    this.#onDocPointerDown = null;
    this.#onKeyDown = null;
    this.#tabEls = [];
    this.#rootEl = this.#build();
  }

  // The positioned popover element. The caller appends this inside a
  // `position: relative` container (the composer wrap).
  get el() {
    return this.#rootEl;
  }

  #build() {
    const grid = h("div", {
      className: "grid grid-cols-8 gap-0.5 overflow-y-auto custom-scrollbar p-2 flex-1 min-h-0",
      "data-testid": "emojiPicker.grid",
    }, []);
    this.#gridEl = grid;

    const tabs = EMOJI_CATEGORIES.map((cat, idx) => {
      const btn = h("button", {
        type: "button",
        className: "w-8 h-8 flex items-center justify-center rounded-lg text-lg leading-none transition-colors hover:bg-primary/15",
        title: cat.label,
        "aria-label": cat.label,
        "data-category": cat.id,
      }, cat.tab);
      btn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.#renderCategory(idx);
      });
      return btn;
    });
    this.#tabEls = tabs;

    const tabStrip = h("div", {
      className: "flex items-center gap-0.5 px-2 pt-2 pb-1 border-b border-outline-variant/30 shrink-0 flex-wrap",
    }, tabs);

    const panel = h("div", {
      className: "hidden absolute bottom-full right-0 mb-2 z-40 w-[336px] h-[320px] flex flex-col bg-surface-container-high border border-outline-variant/30 rounded-xl shadow-2xl overflow-hidden",
      "data-testid": "composer.emojiPicker",
    }, [tabStrip, grid]);

    this.#renderCategory(0);
    return panel;
  }

  #renderCategory(idx) {
    const cat = EMOJI_CATEGORIES[idx] || EMOJI_CATEGORIES[0];
    this.#tabEls.forEach((tab, i) => {
      if (i === idx) tab.classList.add("bg-primary/20", "text-primary");
      else tab.classList.remove("bg-primary/20", "text-primary");
    });
    const buttons = cat.emojis.map((emoji) => {
      const btn = h("button", {
        type: "button",
        className: "w-9 h-9 flex items-center justify-center rounded-lg hover:bg-primary/15 leading-none",
        style: { fontSize: "22px" },
        "data-emoji": emoji,
      }, emoji);
      btn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.#onSelect(emoji);
      });
      return btn;
    });
    this.#gridEl.replaceChildren(...buttons);
    this.#gridEl.scrollTop = 0;
  }

  isOpen() {
    return this.#open;
  }

  toggle(anchorEl) {
    if (this.#open) this.close();
    else this.open(anchorEl);
  }

  open(anchorEl) {
    if (this.#open) return;
    this.#open = true;
    this.#anchorEl = anchorEl || null;
    this.#rootEl.classList.remove("hidden");
    this.#onDocPointerDown = (evt) => {
      if (this.#rootEl.contains(evt.target)) return;
      if (this.#anchorEl && this.#anchorEl.contains(evt.target)) return;
      this.close();
    };
    this.#onKeyDown = (evt) => {
      if (evt.key === "Escape") this.close();
    };
    // Defer attaching the document listener so the click that opened the
    // picker does not immediately close it.
    setTimeout(() => {
      if (this.#onDocPointerDown) document.addEventListener("mousedown", this.#onDocPointerDown);
    }, 0);
    document.addEventListener("keydown", this.#onKeyDown);
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    this.#anchorEl = null;
    this.#rootEl.classList.add("hidden");
    if (this.#onDocPointerDown) {
      document.removeEventListener("mousedown", this.#onDocPointerDown);
      this.#onDocPointerDown = null;
    }
    if (this.#onKeyDown) {
      document.removeEventListener("keydown", this.#onKeyDown);
      this.#onKeyDown = null;
    }
  }

  destroy() {
    this.close();
  }
}
