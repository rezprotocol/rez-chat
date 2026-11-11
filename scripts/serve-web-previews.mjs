import { createWebPreviewServer } from "../src/server/app/createWebPreviewServer.js";

const origin = process.env.REZ_WEB_ORIGIN;
if (!origin) throw new Error("REZ_WEB_ORIGIN required");
const server = createWebPreviewServer({
  origin,
  trustedProxies: String(process.env.REZ_WEB_TRUSTED_PROXIES || "").split(",").map((value) => value.trim()).filter(Boolean),
});
server.maxConnections = 32;
server.listen(8896, "0.0.0.0", () => console.log("Web preview service ready"));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());
