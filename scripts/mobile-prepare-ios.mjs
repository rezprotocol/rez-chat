import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Run after `cargo tauri ios init`. Keep generated-project changes reproducible.
const root = path.resolve(import.meta.dirname, "..");
const project = path.join(root, "mobile/src-tauri/gen/apple/project.yml");
let source = await readFile(project, "utf8");
const marker = "        ENABLE_BITCODE: false";
const setting = '        "OTHER_LDFLAGS[sdk=iphonesimulator*]": $(inherited) -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker "$(PROJECT_DIR)/../../../apple/simulator.entitlements"';
if (!source.includes(setting)) {
  if (!source.includes(marker)) throw new Error("Generated iOS project changed; review native preparation before building");
  source = source.replace(marker, marker + "\n" + setting);
  await writeFile(project, source);
}
execFileSync("xcodegen", ["generate", "--spec", project], { cwd: path.dirname(project), stdio: "inherit" });
console.log("Simulator-only Keychain entitlements embedded. Device signing still requires the real development team.");
