// Passphrase-derived encryption for snapshots/backups.
//
// ENVELOPE ENCRYPTION (see docs/MIGRATION_HISTORY.md, 2026-07):
//   - A random per-folder DEK (Data Encryption Key) actually encrypts files.
//     Stable, never changes; identified by a `dekId`.
//   - The passphrase derives a KEK (PBKDF2-SHA-256 → AES-GCM) whose ONLY job is
//     to WRAP (AES-GCM-encrypt the raw bytes of) the DEK. Changing the passphrase
//     re-wraps the SAME DEK, so old files stay decryptable and a shared folder
//     never splits.
//
// The KEK is NON-EXTRACTABLE (used to wrap/unwrap only, never exported). The DEK
// is EXTRACTABLE — that is required to re-wrap it under a new passphrase for the
// forgot-password recovery path. This is sound here because the local IndexedDB
// is plaintext anyway (the vault only protects Drive snapshots/backups), so an
// XSS attacker with origin script execution can already read the data directly;
// the primary control is preventing XSS. See MIGRATION_HISTORY.md for the full
// trade-off.
//
// `deriveKey` still produces the v1 direct key (used to READ legacy pfdb-v1
// files) and doubles as the KEK — both are exactly PBKDF2 → AES-GCM-256.
//
// IMPORTANT (multi-device family): all devices must derive the KEK from the SAME
// passphrase AND the SAME salt to unwrap the shared DEK. The salt is non-secret
// and shared via the keyring; only the IV is per-encryption random.

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

// --- Envelope: DEK (data key) generation, wrapping, and import ---------------

/** Mint a fresh random DEK — an EXTRACTABLE AES-GCM-256 key (extractable so it
 *  can be re-wrapped under a new passphrase; see the module header). */
export async function generateDek(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Import raw DEK bytes as an EXTRACTABLE AES-GCM key (after unwrapping). */
export async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

/** Wrap the DEK for storage in the keyring: export its raw bytes and AES-GCM
 *  them with the passphrase-derived KEK. Requires `dek` to be extractable. */
export async function wrapDek(kek: CryptoKey, dek: CryptoKey): Promise<EncryptedBlob> {
  const raw = new Uint8Array(await subtle().exportKey("raw", dek));
  return encryptBytes(kek, raw);
}

/** Unwrap the DEK from a keyring blob using the passphrase-derived KEK. Throws
 *  (AES-GCM auth failure) if the passphrase/KEK is wrong — which is exactly how
 *  we verify the passphrase. */
export async function unwrapDek(kek: CryptoKey, wrapped: EncryptedBlob): Promise<CryptoKey> {
  const raw = await decryptBytes(kek, wrapped);
  return importDek(raw);
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
