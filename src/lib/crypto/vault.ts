// Passphrase-derived encryption for snapshots/backups.
//
// PBKDF2(SHA-256) → a NON-EXTRACTABLE AES-GCM key. Non-extractable means JS can
// use the key to encrypt/decrypt but cannot read the key bytes back out — so it
// can be stashed in IndexedDB and reused across refreshes without ever storing
// the passphrase, and an XSS payload can't exfiltrate the key material itself.
//
// IMPORTANT (multi-device family): all devices must derive from the SAME
// passphrase AND the SAME salt to produce the same key. The salt is non-secret
// and shared via the folder; only the IV is per-encryption random.

import { b64ToBytes, bytesToB64, bytesToUtf8, utf8ToBytes } from "./base64";

export const DEFAULT_KDF_ITERATIONS = 600_000;

export interface KdfParams {
  /** base64-encoded random salt (16 bytes), shared across the vault's devices. */
  salt: string;
  iterations: number;
}

export interface EncryptedBlob {
  /** base64 IV (12 bytes), unique per encryption. */
  iv: string;
  /** base64 AES-GCM ciphertext. */
  ciphertext: string;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error("Web Crypto unavailable");
  return c.subtle;
};

export function newSalt(): KdfParams {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  return { salt: bytesToB64(salt), iterations: DEFAULT_KDF_ITERATIONS };
}

/** Derive the non-extractable AES-GCM key for a passphrase + shared salt. */
export async function deriveKey(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  const baseKey = await subtle().importKey(
    "raw",
    utf8ToBytes(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(kdf.salt), iterations: kdf.iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
}

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBlob> {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ct)) };
}

export async function decryptBytes(key: CryptoKey, blob: EncryptedBlob): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: b64ToBytes(blob.iv) },
    key,
    b64ToBytes(blob.ciphertext),
  );
  return new Uint8Array(pt);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<EncryptedBlob> {
  return encryptBytes(key, utf8ToBytes(JSON.stringify(value)));
}

export async function decryptJson<T>(key: CryptoKey, blob: EncryptedBlob): Promise<T> {
  return JSON.parse(bytesToUtf8(await decryptBytes(key, blob))) as T;
}
