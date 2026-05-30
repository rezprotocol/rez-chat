import fs from "node:fs/promises";
import path from "node:path";
import { createDefaultRezConfig } from "./defaultRezConfig.js";

export async function loadRezConfig({ cwd = process.cwd(), configPath = null } = {}) {
  const resolvedConfigPath = configPath
    ? path.resolve(cwd, configPath)
    : path.join(cwd, "rez.config.json");
  const exists = await fileExists(resolvedConfigPath);

  if (!exists) {
    const defaults = createDefaultRezConfig({
      dataDir: path.join(".local", "rez-node-data"),
    });
    await fs.mkdir(path.dirname(resolvedConfigPath), { recursive: true });
    const raw = JSON.stringify(defaults, null, 2) + "\n";
    await fs.writeFile(resolvedConfigPath, raw, "utf8");
    return { config: structuredClone(defaults), configPath: resolvedConfigPath, created: true };
  }

  const raw = await fs.readFile(resolvedConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  return { config: parsed, configPath: resolvedConfigPath, created: false };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
