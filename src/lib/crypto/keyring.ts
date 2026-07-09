// The keyring: a small shared file in the Drive folder that holds the folder's
// DEK, wrapped by the passphrase-derived KEK. It is the single source of "which
// passphrase currently unlocks this folder's data".
//
// See docs/MIGRATION_HISTORY.md (2026-07 envelope-encryption entry) for the full
// model. Kept PURE here (format + parse/serialize + validation); the Drive
// transport lives in the provider and the wrap/unwrap in vault.ts.

import { bytesToUtf8, utf8ToBytes } from "./base64";
import type { EncryptedBlob, KdfParams } from "./vault";

export const KEYRING_FORMAT = "pf-keyring-v1";

export interface Keyring {
  format: typeof KEYRING_FORMAT;
  /** Monotonic counter — the single source of "latest keyring", bumped on every
   *  password change. Same semantics as a snapshot's version. */
  version: number;
  /** Stable random id of the DEK this keyring wraps — the folder-DATA identity
   *  (unchanged across password changes; only a brand-new DEK gets a new id). */
  dekId: string;
  /** KDF params for the KEK that wraps `wrappedDEK`. Changes on a password change
   *  (fresh salt); non-secret. */
  kdf: KdfParams;
  /** The DEK's raw bytes, AES-GCM-encrypted by the KEK. */
  wrappedDEK: EncryptedBlob;
}

/** Standard (btoa-style) base64: our encoder always emits padded, standard-alphabet
 *  base64, so a value that isn't shaped like that is corrupt/foreign and must be
 *  rejected here — otherwise it reaches `deriveKey`/`decrypt` and throws an
 *  uncaught OperationError (a cryptic lockout) instead of being treated as an
 *  invalid keyring (→ absent → fall back to the good local one). Exported so the
 *  backup reader (codec.ts) applies the same check to an embedded keyring. */
export function isB64(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
}

/** Minimal shape a keyring-selection needs: the Drive file id + its version. */
export interface KeyringRef {
  id: string;
  version: number;
}

/** THE canonical "which keyring is newest" order — highest version, then highest
 *  id (deterministic across devices). Kept in ONE place and reused by every site
 *  that picks/prunes a winner (remoteKeyring, changePassword, pruneKeyrings), so
 *  the safety-critical ordering can't drift between them. Sort comparator: sorts
 *  newest first. */
export function compareKeyringNewestFirst(a: KeyringRef, b: KeyringRef): number {
  return b.version - a.version || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** The single newest keyring by {@link compareKeyringNewestFirst}, or undefined. */
export function newestKeyring<T extends KeyringRef>(metas: T[]): T | undefined {
  let best: T | undefined;
  for (const m of metas) if (!best || compareKeyringNewestFirst(m, best) < 0) best = m;
  return best;
}

function isBlob(v: unknown): v is EncryptedBlob {
  const b = v as EncryptedBlob;
  return typeof v === "object" && v !== null && isB64(b.iv) && isB64(b.ciphertext);
}

function isKdf(v: unknown): v is KdfParams {
  const k = v as KdfParams;
  // iterations must be a positive integer — 0/negative/fractional would make
  // PBKDF2 reject and lock the user out; salt must be decodable base64.
  return (
    typeof v === "object" &&
    v !== null &&
    isB64(k.salt) &&
    Number.isInteger(k.iterations) &&
    k.iterations >= 1
  );
}

/** Validate an untrusted object as a Keyring, or throw. Rejects malformed /
 *  wrong-format / non-finite-version files so a corrupt keyring never poisons
 *  version math or unlock. */
export function validateKeyring(v: unknown): Keyring {
  const k = v as Partial<Keyring>;
  if (!k || k.format !== KEYRING_FORMAT) throw new Error("not a pf-keyring-v1 file");
  if (!Number.isFinite(k.version) || (k.version as number) < 0) {
    throw new Error("keyring has an invalid version");
  }
  if (typeof k.dekId !== "string" || k.dekId.length === 0) {
    throw new Error("keyring is missing its dekId");
  }
  if (!isKdf(k.kdf)) throw new Error("keyring is missing/invalid KDF params");
  if (!isBlob(k.wrappedDEK)) throw new Error("keyring is missing its wrapped key");
  return {
    format: KEYRING_FORMAT,
    version: k.version as number,
    dekId: k.dekId,
    kdf: k.kdf,
    wrappedDEK: k.wrappedDEK,
  };
}

export function isKeyringFile(bytes: Uint8Array): boolean {
  try {
    const head = JSON.parse(bytesToUtf8(bytes)) as { format?: string };
    return head.format === KEYRING_FORMAT;
  } catch {
    return false;
  }
}

export function parseKeyring(bytes: Uint8Array): Keyring {
  return validateKeyring(JSON.parse(bytesToUtf8(bytes)));
}

export function encodeKeyring(keyring: Keyring): Uint8Array {
  return utf8ToBytes(JSON.stringify(keyring));
}
