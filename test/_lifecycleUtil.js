export async function waitForCondition(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

export function isBindPermissionError(err) {
  return ["EACCES", "EPERM"].includes(err?.code);
}
