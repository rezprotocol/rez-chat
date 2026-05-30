import { randomBytes } from "node:crypto";

export function newDefaultThreadId() {
  const bytes = randomBytes(16);
  const b64 = bytes.toString("base64url");
  return `th_${b64.slice(0, 22)}`;
}

export function createDefaultRezConfig({ dataDir = ".local/rez-node-data" } = {}) {
  return {
    node: {
      ws: {
        port: 8787,
        path: "/ws",
      },
      storage: {
        dataDir: String(dataDir),
        defaultThreadId: newDefaultThreadId(),
      },
      backup: {
        retentionDays: 90,
      },
      network: {
        participateInRouting: true,
        knownRelays: [
          {
            id: "ws:relay1",
            relayKeyId: "ws:relay1",
            host: "r1.rezprotocol.io",
            port: 8443,
            transport: "tcp",
            tls: true,
            directoryUrl: "https://r1.rezprotocol.io",
          },
          {
            id: "ws:relay2",
            relayKeyId: "ws:relay2",
            host: "r2.rezprotocol.io",
            port: 8443,
            transport: "tcp",
            tls: true,
            directoryUrl: "https://r2.rezprotocol.io",
          },
          {
            id: "ws:relay3",
            relayKeyId: "ws:relay3",
            host: "r3.rezprotocol.io",
            port: 8443,
            transport: "tcp",
            tls: true,
            directoryUrl: "https://r3.rezprotocol.io",
          },
        ],
      },
    },
  };
}
