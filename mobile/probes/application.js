import { installMobileApplication } from "../../src/mobile/MobileApplicationHost.js";
import { MobileLifecycleRequestV1 } from "../../src/mobile/MobileHostRecords.js";

const host = installMobileApplication({ accountHomeUplinks: ["wss://enrollment.example.invalid/ws"], portableUplinks: ["wss://portable.example.invalid/ws"] }, (json) => __rezResult(json));
host.lifecycle(new MobileLifecycleRequestV1({ id: "probe-foreground", name: "onForeground" }));
// Test topology only: preserve production URL validation while exercising the
// real OS WebSocket against an isolated loopback provider, with no TLS bypass.
const NativeSocket = globalThis.WebSocket;
globalThis.WebSocket = class {
  constructor(url) {
    if (url === "wss://portable.example.invalid/ws") return new NativeSocket(globalThis.__rezProbeUplink);
    if (url === "wss://enrollment.example.invalid/ws" && globalThis.__rezProbeAccountHome) return new NativeSocket(globalThis.__rezProbeAccountHome);
    throw new Error("Unexpected native test uplink");
  }
};
