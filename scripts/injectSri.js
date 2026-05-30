/**
 * Post-build SRI injection.
 *
 * Reads the built index.html from artifacts/rez-chat/, computes SHA-384 hashes
 * for all local asset <script> and <link rel="stylesheet"> tags, and writes
 * `integrity="sha384-..."` onto each element.
 *
 * Note: Vite already emits `crossorigin` on script/link tags, so we do not
 * duplicate it here — we only inject the `integrity` attribute.
 *
 * Run automatically as part of `npm run build`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = path.resolve(__dirname, "../artifacts/rez-chat");
const INDEX_HTML = path.join(ARTIFACTS_DIR, "index.html");

async function computeSha384(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash("sha384").update(bytes).digest("base64");
}

/** Extract attribute value from a raw tag string, or null if not present. */
function getAttr(tagStr, name) {
  const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const m = re.exec(tagStr);
  return m ? m[1] : null;
}

function hasAttr(tagStr, name) {
  return new RegExp(`\\b${name}\\b`, "i").test(tagStr);
}

async function injectSri() {
  let html = await fs.readFile(INDEX_HTML, "utf8");

  // Match all self-contained <script ...> and <link ...> tags
  const tagRe = /<(script|link)(\s[^>]*)>/g;

  const replacements = [];
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    const [fullTag, tagName, attrs] = match;

    // Skip if already has integrity
    if (hasAttr(attrs, "integrity")) continue;

    let assetPath = null;
    if (tagName === "script") {
      assetPath = getAttr(attrs, "src");
    } else if (tagName === "link") {
      // Only hash stylesheet links
      const rel = getAttr(attrs, "rel");
      if (rel !== "stylesheet") continue;
      assetPath = getAttr(attrs, "href");
    }

    if (!assetPath || !assetPath.startsWith("/assets/")) continue;

    const absPath = path.join(ARTIFACTS_DIR, assetPath);
    let hash;
    try {
      hash = await computeSha384(absPath);
    } catch (err) {
      console.warn(`[injectSri] could not hash ${absPath}: ${err.message}`);
      continue;
    }

    // Insert integrity attribute before the closing >
    // Also ensure crossorigin is present (required for SRI on cross-origin loads);
    // Vite already adds it for scripts, but link tags may lack it.
    let replacement = fullTag;
    if (!hasAttr(attrs, "crossorigin")) {
      replacement = replacement.replace(/>$/, ` crossorigin="anonymous">`);
    }
    replacement = replacement.replace(/>$/, ` integrity="sha384-${hash}">`);
    replacements.push({ full: fullTag, replacement });
  }

  for (const { full, replacement } of replacements) {
    html = html.replace(full, replacement);
  }

  await fs.writeFile(INDEX_HTML, html, "utf8");
  console.log(`[injectSri] wrote ${INDEX_HTML} (${replacements.length} asset(s) hashed)`);
}

injectSri().catch((err) => {
  console.error("[injectSri] fatal:", err.message);
  process.exit(1);
});
