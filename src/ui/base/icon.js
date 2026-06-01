import { h } from "@rezprotocol/ui";

/**
 * Create a Material Symbols Outlined icon element.
 *
 * The icon name is the Material Symbols ligature (e.g. "chat", "contacts",
 * "settings", "lock_open", "send", "verified_user"). Names use snake_case
 * — see https://fonts.google.com/icons for the catalog.
 *
 * @param {string} name  Material Symbols ligature
 * @param {object} [opts]
 * @param {"regular"|"fill"} [opts.weight="regular"]  Whether to set FILL=1
 * @param {number|string} [opts.size]                 Font-size in px (uses Material's opsz axis too)
 * @param {string} [opts.className]                   Extra CSS classes
 * @returns {HTMLElement}
 */
export function materialIcon(name, { weight = "regular", size = null, className = "" } = {}) {
  const cls = ["material-symbols-outlined", className].filter(Boolean).join(" ");
  const style = {};
  if (size !== null && size !== undefined && size !== "") {
    style.fontSize = size + "px";
  }
  if (weight === "fill") {
    style.fontVariationSettings = "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24";
  }
  return h("span", { className: cls, style }, name);
}
