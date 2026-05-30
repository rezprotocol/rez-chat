function getDesktopBridge() {
  const root = typeof globalThis !== "undefined" ? globalThis : {};
  const windowRef = root && root.window ? root.window : null;
  const bridge = root.rezDesktop || (windowRef && windowRef.rezDesktop) || null;
  return bridge && typeof bridge === "object" ? bridge : null;
}

function isElectronRuntime() {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const ua = nav && typeof nav.userAgent === "string" ? nav.userAgent : "";
  return /\bElectron\//.test(ua);
}

export function createAuthCryptoProvider() {
  const cryptoObj = globalThis.crypto || null;
  const desktop = getDesktopBridge();
  const subtle = cryptoObj && cryptoObj.subtle ? cryptoObj.subtle : null;
  const getRandomValues =
    cryptoObj && typeof cryptoObj.getRandomValues === "function"
      ? cryptoObj.getRandomValues.bind(cryptoObj)
      : null;
  const generateSigningKeyPair =
    desktop && typeof desktop.generateSigningKeyPair === "function"
      ? async () => {
        const pair = await desktop.generateSigningKeyPair();
        const row = pair && typeof pair === "object" ? pair : {};
        return {
          publicKey: row.publicKey instanceof Uint8Array ? row.publicKey : new Uint8Array(row.publicKey || []),
          privateKey: row.privateKey instanceof Uint8Array ? row.privateKey : new Uint8Array(row.privateKey || []),
        };
      }
      : null;
  if (!generateSigningKeyPair) {
    if (isElectronRuntime() && !subtle) throw new Error("Electron desktop crypto bridge missing");
    return cryptoObj;
  }
  return {
    crypto: cryptoObj,
    subtle,
    getRandomValues,
    generateSigningKeyPair,
  };
}
