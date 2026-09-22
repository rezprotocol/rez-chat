import { installMobileApplication } from "../../src/mobile/MobileApplicationHost.js";
import { MobileLifecycleRequestV1 } from "../../src/mobile/MobileHostRecords.js";

// Exercise actual configured WSS origins. No URL rewriting or TLS bypass.
const host = installMobileApplication(globalThis.__rezHostedConfig, (json) => __rezResult(json));
host.lifecycle(new MobileLifecycleRequestV1({ id: "hosted-foreground", name: "onForeground" }));
