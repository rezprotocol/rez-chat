export function runtimeEnvFlag(name) {
  const key = String(name || "").trim();
  if (!key) return false;
  const runtimeProcess = typeof globalThis.process === "object" && globalThis.process
    ? globalThis.process
    : null;
  const env = runtimeProcess && runtimeProcess.env && typeof runtimeProcess.env === "object"
    ? runtimeProcess.env
    : null;
  return !!env && env[key] === "1";
}
