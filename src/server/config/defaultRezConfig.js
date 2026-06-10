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
        // TRUST-7: pin each relay's node identity public key (the key it signs
        // its peer-auth challenge with). The local node asserts the relay presents
        // exactly this key before trusting the connection — closing the rogue/MITM
        // relay-by-self-claim gap (a TLS endpoint can no longer impersonate a relay
        // without its node private key). Keys read from the live r1/r2/r3 node
        // identities (nodeIdentity:v1). nodeKeyId is hash(pubkey) for reference.
        knownRelays: [
          {
            id: "ws:relay1",
            relayKeyId: "ws:relay1",
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
            relayKeyId: "ws:relay2",
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
            relayKeyId: "ws:relay3",
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
