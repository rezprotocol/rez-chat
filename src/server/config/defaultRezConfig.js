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
        // TRUST-7 + ADR-RELAY-IDENTITY: relayKeyId is now SELF-CERTIFYING —
        // rez:relay:sha256hex(node public key SPKI DER), derived here from the
        // live r1/r2/r3 node identity keys (nodeIdentity:v1). The `id` field is
        // a human label only (metadata, never identity). The pinned
        // nodePublicKeyB64 must re-derive to relayKeyId or the connection is
        // rejected. NOTE: the deployed relays must be redeployed WITHOUT a
        // configured relay.relayKeyId (they derive it) before these entries
        // authenticate — the pre-launch one-time identity reset.
        knownRelays: [
          {
            id: "ws:relay1",
            relayKeyId: "rez:relay:d045f1d7c0c61f9f7a30ff6735e112b498ba62ae70d30eddd1773683cde0d1d8",
            host: "r1.rezprotocol.io",
            port: 8443,
            transport: "tcp",
            tls: true,
            directoryUrl: "https://r1.rezprotocol.io",
            nodeKeyId: "nodekey:d045f1d7c0c61f9f7a30ff6735e112b4",
            nodePublicKeyB64: "MCowBQYDK2VwAyEA1yNYqvjT/8ivomW/x8w1NI07pysV23k1WLJVU24yHcY=",
          },
          {
            id: "ws:relay2",
            relayKeyId: "rez:relay:4596facfe502588659db067a23cb04ad73870414c7e5f32e8414106d833332af",
            host: "r2.rezprotocol.io",
            port: 8443,
            transport: "tcp",
            tls: true,
            directoryUrl: "https://r2.rezprotocol.io",
            nodeKeyId: "nodekey:4596facfe502588659db067a23cb04ad",
            nodePublicKeyB64: "MCowBQYDK2VwAyEAChEyd37sq2Zxn7WVR16BeALVpKXjIxJlLtJjpu1Ov2k=",
          },
          {
            id: "ws:relay3",
            relayKeyId: "rez:relay:c679f0cff57ac8d52821702ccfbf1fd38a346f05598c10c0a782c003a2c28501",
            host: "r3.rezprotocol.io",
            port: 8443,
            transport: "tcp",
            tls: true,
            directoryUrl: "https://r3.rezprotocol.io",
            nodeKeyId: "nodekey:c679f0cff57ac8d52821702ccfbf1fd3",
            nodePublicKeyB64: "MCowBQYDK2VwAyEAausth2L9Z+wKQ0CAc+DWOVEiWy8rJSVHq1D0JSoxZXw=",
          },
        ],
      },
    },
  };
}
