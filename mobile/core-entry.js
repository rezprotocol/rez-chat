import { installMobileApplication } from "../src/mobile/MobileApplicationHost.js";

globalThis.__rezStartMobile = (configJson) => installMobileApplication(JSON.parse(configJson), (json) => __rezResult(json));
