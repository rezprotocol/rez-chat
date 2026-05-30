import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { newDefaultThreadId } from "../src/server/config/defaultRezConfig.js";

export async function createTempRezChatConfig({
  prefix = "rez-chat-test-",
  wsHost = "127.0.0.1",
  wsPort = 0,
  wsPath = "/ws",
  defaultThreadId = null,
} = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const configPath = path.join(rootDir, "rez.config.json");
  const dataDir = path.join(rootDir, "node-data");

  const config = {
    node: {
      ws: {
        host: String(wsHost),
        port: Number(wsPort),
        path: String(wsPath),
      },
      storage: {
        dataDir,
        defaultThreadId: String(defaultThreadId || newDefaultThreadId()),
      },
      network: {
        participateInRouting: true,
        knownRelays: [],
      },
    },
  };

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    rootDir,
    configPath,
    dataDir,
    config,
    async cleanup() {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
