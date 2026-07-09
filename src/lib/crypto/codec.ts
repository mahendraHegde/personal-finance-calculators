// The `.pfdb` snapshot/backup file format and its Codec implementations.
//
// File = a small cleartext header (format + KDF params + IV) wrapping an
// AES-GCM ciphertext. Only the ciphertext is secret; salt/iv/kdf are needed to
// derive the key and must travel in the clear. A plaintext codec is also
// provided for users who don't set a passphrase.

import type { Codec } from "../sync/types";
import { b64ToBytes, bytesToB64, bytesToUtf8, utf8ToBytes } from "./base64";
import { isB64 } from "./keyring";
import type { EncryptedBlob, KdfParams } from "./vault";
import { decryptBytes, encryptBytes } from "./vault";

/** Legacy direct-keyed file (pre-envelope). Still READ for backward compat;
 *  never written by v2. The key was derived straight from the passphrase, so the
 *  header carries its KDF params. */
export interface PfdbEncrypted extends EncryptedBlob {
  format: "pfdb-v1";
  kdf: KdfParams;
}

/** A keyring embedded in a self-contained backup file (NOT in folder snapshots,
 *  which recover the DEK from the folder's separate keyring). Lets a fresh device
 *  restore an exported backup with only the passphrase.
 *
 *  `dekId` identifies the DEK so a restore ONTO THE FOLDER IT CAME FROM preserves
 *  the folder's data identity instead of minting a new id (which would look like a
 *  DEK rotation and lock other devices out). Optional for forward-compat with any
 *  backup written before this field existed. */
export interface EmbeddedKeyring {
  dekId?: string;
  kdf: KdfParams;
  wrappedDEK: EncryptedBlob;
}

/** Envelope-era file: sealed with the folder DEK.
 *  - Folder snapshots omit `keyring` (the DEK comes from the folder keyring).
 *  - Exported backups embed `keyring` so they're self-contained (passphrase +
 *    embedded wrapped-DEK → DEK → body). No per-file KDF on the body itself. */
export interface PfdbV2 extends EncryptedBlob {
  format: "pfdb-v2";
  keyring?: EmbeddedKeyring;
}

export interface PfdbPlain {
  format: "pfdb-plain-v1";
  data: unknown;
}

/** The encryption era of a `.pfdb` file (for callers that must branch on it,
 *  e.g. reading the KDF salt from a v1 header). Null when not an encrypted file. */
export function encryptedFormat(bytes: Uint8Array): "pfdb-v1" | "pfdb-v2" | null {
  try {
    const head = JSON.parse(bytesToUtf8(bytes)) as { format?: string };
    if (head.format === "pfdb-v1" || head.format === "pfdb-v2") return head.format;
    return null;
  } catch {
    return null;
  }
}

export function isEncryptedFile(bytes: Uint8Array): boolean {
  return encryptedFormat(bytes) !== null;
}

/** Envelope codec: seals/opens `pfdb-v2` files with the folder DEK. This is what
 *  v2 always WRITES. */
export function createDekCodec<T>(dek: CryptoKey): Codec<T> {
  return {
    async encode(doc: T): Promise<Uint8Array> {
      const blob = await encryptBytes(dek, utf8ToBytes(JSON.stringify(doc)));
      const file: PfdbV2 = { format: "pfdb-v2", ...blob };
      return utf8ToBytes(JSON.stringify(file));
    },
    async decode(bytes: Uint8Array): Promise<T> {
      const file = JSON.parse(bytesToUtf8(bytes)) as PfdbV2;
      if (file.format !== "pfdb-v2") throw new Error("not a pfdb-v2 file");
      const plain = await decryptBytes(dek, { iv: file.iv, ciphertext: file.ciphertext });
      return JSON.parse(bytesToUtf8(plain)) as T;
    },
  };
}

/** Encode a SELF-CONTAINED backup: DEK-sealed body + the embedded keyring so it
 *  can be restored on a fresh device with only the passphrase. */
export async function encodeBackup<T>(
  dek: CryptoKey,
  doc: T,
  keyring: EmbeddedKeyring,
): Promise<Uint8Array> {
  const blob = await encryptBytes(dek, utf8ToBytes(JSON.stringify(doc)));
  const file: PfdbV2 = { format: "pfdb-v2", ...blob, keyring };
  return utf8ToBytes(JSON.stringify(file));
}

/** Read the keyring embedded in a backup file (null for a folder snapshot, a
 *  non-v2 file, or a MALFORMED embedded keyring). Used to unwrap the DEK when
 *  restoring on a device without it. Validates shape so a hand-edited/corrupt
 *  backup surfaces a clean "can't open" error instead of crashing downstream on
 *  `embedded.kdf`. */
export function readEmbeddedKeyring(bytes: Uint8Array): EmbeddedKeyring | null {
  try {
    const f = JSON.parse(bytesToUtf8(bytes)) as PfdbV2;
    if (f.format !== "pfdb-v2" || !f.keyring) return null;
    const { dekId, kdf, wrappedDEK } = f.keyring;
    // Same base64/iteration checks the keyring validator uses, so a corrupt embedded
    // keyring reads as null (clean "can't open") instead of crashing deriveKey /
    // decrypt on a non-base64 salt/iv downstream. dekId must be a string when present
    // (a non-string would later be stamped into the keyring + Drive appProperties and
    // break dekId comparisons / validateKeyring).
    const okDekId = dekId === undefined || typeof dekId === "string";
    const okKdf = kdf && isB64(kdf.salt) && Number.isInteger(kdf.iterations) && kdf.iterations >= 1;
    const okBlob = wrappedDEK && isB64(wrappedDEK.iv) && isB64(wrappedDEK.ciphertext);
    return okDekId && okKdf && okBlob ? f.keyring : null;
  } catch {
    return null;
  }
}

/** Legacy direct-keyed codec: holds the passphrase-derived key + its salt. Used
 *  only to READ pre-envelope `pfdb-v1` files (migration / historical restore). */
export function createEncryptedCodec<T>(key: CryptoKey, kdf: KdfParams): Codec<T> {
  return {
    async encode(doc: T): Promise<Uint8Array> {
      const blob = await encryptBytes(key, utf8ToBytes(JSON.stringify(doc)));
      const file: PfdbEncrypted = { format: "pfdb-v1", kdf, ...blob };
      return utf8ToBytes(JSON.stringify(file));
    },
    async decode(bytes: Uint8Array): Promise<T> {
      const file = JSON.parse(bytesToUtf8(bytes)) as PfdbEncrypted;
      if (file.format !== "pfdb-v1") throw new Error("not a pfdb-v1 file");
      if (!file.kdf || typeof file.kdf.salt !== "string") {
        throw new Error("v1 file is missing its key parameters");
      }
      if (file.kdf.salt !== kdf.salt) {
        throw new Error("snapshot was encrypted with a different vault passphrase/salt");
      }
      const plain = await decryptBytes(key, { iv: file.iv, ciphertext: file.ciphertext });
      return JSON.parse(bytesToUtf8(plain)) as T;
    },
  };
}

/** Plaintext codec (no passphrase set). Portable, human-readable JSON. */
export function createPlainCodec<T>(): Codec<T> {
  return {
    async encode(doc: T): Promise<Uint8Array> {
      const file: PfdbPlain = { format: "pfdb-plain-v1", data: doc };
      return utf8ToBytes(JSON.stringify(file, null, 2));
    },
    async decode(bytes: Uint8Array): Promise<T> {
      const file = JSON.parse(bytesToUtf8(bytes)) as PfdbPlain;
      if (file.format !== "pfdb-plain-v1") throw new Error("not a plain .pfdb file");
      return file.data as T;
    },
  };
}

/** base64 helpers re-exported for callers building file blobs. */
export { b64ToBytes, bytesToB64 };
