// The `.pfdb` snapshot/backup file format and its Codec implementations.
//
// File = a small cleartext header (format + KDF params + IV) wrapping an
// AES-GCM ciphertext. Only the ciphertext is secret; salt/iv/kdf are needed to
// derive the key and must travel in the clear. A plaintext codec is also
// provided for users who don't set a passphrase.

import type { Codec } from "../sync/types";
import { b64ToBytes, bytesToB64, bytesToUtf8, utf8ToBytes } from "./base64";
import type { EncryptedBlob, KdfParams } from "./vault";
import { decryptBytes, encryptBytes } from "./vault";

export interface PfdbEncrypted extends EncryptedBlob {
  format: "pfdb-v1";
  kdf: KdfParams;
}

export interface PfdbPlain {
  format: "pfdb-plain-v1";
  data: unknown;
}

export function isEncryptedFile(bytes: Uint8Array): boolean {
  try {
    const head = JSON.parse(bytesToUtf8(bytes)) as { format?: string };
    return head.format === "pfdb-v1";
  } catch {
    return false;
  }
}

/** Encrypting codec: holds the derived key + its shared salt. */
export function createEncryptedCodec<T>(key: CryptoKey, kdf: KdfParams): Codec<T> {
  return {
    async encode(doc: T): Promise<Uint8Array> {
      const blob = await encryptBytes(key, utf8ToBytes(JSON.stringify(doc)));
      const file: PfdbEncrypted = { format: "pfdb-v1", kdf, ...blob };
      return utf8ToBytes(JSON.stringify(file));
    },
    async decode(bytes: Uint8Array): Promise<T> {
      const file = JSON.parse(bytesToUtf8(bytes)) as PfdbEncrypted;
      if (file.format !== "pfdb-v1") throw new Error("not an encrypted .pfdb file");
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
