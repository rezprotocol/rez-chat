import { NativePrimitiveClient, NativeWebCrypto } from "@rezprotocol/sdk/native";
import { BrowserCryptoProvider } from "@rezprotocol/sdk/client";

const primitive = new NativePrimitiveClient(globalThis.__rezNativeInvoke);
const subtle = new NativeWebCrypto(primitive);
globalThis.crypto = { subtle, getRandomValues: (value) => subtle.getRandomValues(value) };

async function probe() {
  const provider = new BrowserCryptoProvider();
  const bytes = new TextEncoder().encode("Rez native crypto interop");
  const keys = await provider.signingKeyPairFromSeed(new Uint8Array(32).fill(7));
  const signature = await provider.sign({ privateKey: keys.privateKey, msg: bytes });
  if (!await provider.verify({ publicKey: keys.publicKey, msg: bytes, sig: signature })) throw new Error("Ed25519 roundtrip failed");
  const alice = await provider.dhGenerateKeyPair();
  const bob = await provider.dhGenerateKeyPair();
  const a = await provider.dhDerive({ privateKey: alice.privateKey, publicKey: bob.publicKey });
  const b = await provider.dhDerive({ privateKey: bob.privateKey, publicKey: alice.publicKey });
  if (String(a) !== String(b)) throw new Error("X25519 roundtrip failed");
  const key = await provider.hkdfSha256(a, { salt: bytes, info: bytes, length: 32 });
  const nonce = provider.randomBytes(12);
  const ciphertext = await provider.aeadEncrypt({ key, nonce, plaintext: bytes, aad: bytes });
  const plaintext = await provider.aeadDecrypt({ key, nonce, ciphertext, aad: bytes });
  if (String(bytes) !== String(plaintext)) throw new Error("AES-GCM roundtrip failed");
  ciphertext[0] ^= 1;
  let refused = false;
  try { await provider.aeadDecrypt({ key, nonce, ciphertext, aad: bytes }); } catch { refused = true; }
  if (!refused) throw new Error("Tampered ciphertext accepted");
  const pbkdfKey = await subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveBits"]);
  const derived = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes, iterations: 1000 }, pbkdfKey, 256);
  const expected = globalThis.__rezExpectedCrypto;
  if (!expected) throw new Error("Independent crypto reference vectors are required");
  const equal = (actual, reference, label) => { if (String(Array.from(actual)) !== String(reference)) throw new Error(label + " reference mismatch"); };
  equal(bytes, expected.message, "UTF-8 encoding");
  equal(keys.publicKey, expected.publicKey, "Ed25519 public key");
  // CryptoKit deliberately randomizes Ed25519 signatures. Verify the Node
  // reference here; the harness verifies our native signature in Node.
  if (!await provider.verify({ publicKey: keys.publicKey, msg: bytes, sig: Uint8Array.from(expected.signature) })) throw new Error("Node signature rejected by native verifier");
  equal(new Uint8Array(derived), expected.pbkdf, "PBKDF2");
  const dh = await provider.dhDerive({ privateKey: Uint8Array.from(expected.dhPrivate), publicKey: Uint8Array.from(expected.dhPublic) });
  equal(dh, expected.dh, "X25519");
  const hkdf = await provider.hkdfSha256(dh, { salt: bytes, info: bytes, length: 32 });
  equal(hkdf, expected.hkdf, "HKDF");
  const cipher = await provider.aeadEncrypt({ key: hkdf, nonce: new Uint8Array(12).fill(3), plaintext: bytes, aad: bytes });
  equal(cipher, expected.ciphertext, "AES-GCM");
  const hash = await provider.hashSha256(bytes);
  equal(hash, expected.sha256, "SHA256");
  let nonextractable = false;
  try { await subtle.exportKey("raw", pbkdfKey); } catch { nonextractable = true; }
  if (!nonextractable) throw new Error("Nonextractable key exported");
  let invalidUsage = false;
  try { await subtle.importKey("spki", keys.publicKey, "Ed25519", true, ["sign"]); } catch { invalidUsage = true; }
  if (!invalidUsage) throw new Error("Public signing key accepted");
  __rezResult(JSON.stringify({ complete: true, ok: true, publicKey: Array.from(keys.publicKey), signature: Array.from(signature), pbkdf: Array.from(new Uint8Array(derived)) }));
}
probe().catch((err) => __rezResult(JSON.stringify({ complete: true, ok: false, error: String(err) + "\n" + String(err.stack || "") })));
