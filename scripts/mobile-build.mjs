import { build as bundle } from "esbuild";
import { build as buildUi } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MobileHostConfigV1 } from "../src/mobile/MobileHostRecords.js";

const root = path.resolve(import.meta.dirname, "..");
const configPath = process.argv[2];
if (!configPath) throw new Error("Usage: node scripts/mobile-build.mjs <deployment.json>. The example is an offline fixture, not a deployment.");
const config = new MobileHostConfigV1(JSON.parse(await readFile(path.resolve(configPath), "utf8")));
const output = path.join(root, "mobile/dist");
await buildUi({ root, build: { outDir: output, emptyOutDir: true }, plugins: [{
  name: "rez-mobile-entry",
  transformIndexHtml(html) {
    return html.replace("initial-scale=1", "initial-scale=1,viewport-fit=cover").replace('<script type="module"', '<script src="/mobile-flag.js"></script><script type="module"');
  },
}] });
await bundle({ entryPoints: [path.join(root, "mobile/ui-entry.js")], bundle: true, platform: "browser", format: "iife", outfile: path.join(output, "mobile-flag.js") });
await writeFile(path.join(output, "mobile-deployment.json"), JSON.stringify(config.toJSON()));
const core = await bundle({ entryPoints: [path.join(root, "mobile/core-entry.js")], bundle: true, platform: "browser", format: "iife", external: ["node:*"], outfile: path.join(output, "mobile-core.js"), metafile: true });
if (Object.keys(core.metafile.inputs).some((file) => file.endsWith("storage/fs/FileSystemDataStore.js"))) throw new Error("Desktop filesystem leaked into mobile core");
console.log("Mobile UI and native core built. Native packaging and device acceptance remain separate gates.");
