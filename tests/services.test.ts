// Tests for the service layer added in phases 5–6: crypto vault + codec, FX
// parsing/rebase, and the generic sync engine (with an in-memory provider).

import {
  decryptBytes,
  deriveKey,
  encryptBytes,
  encryptJson,
  decryptJson,
  generateDek,
  newSalt,
  unwrapDek,
  wrapDek,
} from "../src/lib/crypto/vault";
import {
  createDekCodec,
  createEncryptedCodec,
  createPlainCodec,
  encodeBackup,
  encryptedFormat,
  isEncryptedFile,
  readEmbeddedKeyring,
} from "../src/lib/crypto/codec";
import {
  encodeKeyring,
  isKeyringFile,
  KEYRING_FORMAT,
  parseKeyring,
  validateKeyring,
} from "../src/lib/crypto/keyring";
import { parseErApi, withOverrides } from "../src/lib/fx/fx-service";
import { rebase } from "../src/lib/money/currency";
import { SyncEngine, snapshotName } from "../src/lib/sync/engine";
import { latestSnapshot, type SnapshotMeta, type SyncProvider } from "../src/lib/sync/types";
import { done, eq, near, ok, section } from "./_harness";

// ---------------------------------------------------------------------------
section("[vault] encrypt → decrypt round trip");
{
  const kdf = newSalt();
  const key = await deriveKey("correct horse battery staple", kdf);
  const blob = await encryptJson(key, { secret: 42, name: "priya" });
  const back = await decryptJson<{ secret: number; name: string }>(key, blob);
  eq(back.secret, 42, "decrypts number");
  eq(back.name, "priya", "decrypts string");
  ok(blob.ciphertext.length > 0 && blob.iv.length > 0, "produces iv + ciphertext");
}

section("[vault] wrong passphrase fails to decrypt");
{
  const kdf = newSalt();
  const key = await deriveKey("right", kdf);
  const wrong = await deriveKey("wrong", kdf);
  const blob = await encryptJson(key, { x: 1 });
  let threw = false;
  try {
    await decryptJson(wrong, blob);
  } catch {
    threw = true;
  }
  ok(threw, "wrong key cannot decrypt");
}

// ---------------------------------------------------------------------------
section("[codec] encrypted .pfdb round trip + tamper/salt checks");
{
  const kdf = newSalt();
  const key = await deriveKey("pass", kdf);
  const codec = createEncryptedCodec<{ v: number }>(key, kdf);
  const bytes = await codec.encode({ v: 7 });
  ok(isEncryptedFile(bytes), "isEncryptedFile detects encrypted file");
  const back = await codec.decode(bytes);
  eq(back.v, 7, "decodes value");

  const otherKdf = newSalt();
  const otherCodec = createEncryptedCodec<{ v: number }>(await deriveKey("pass", otherKdf), otherKdf);
  let threw = false;
  try {
    await otherCodec.decode(bytes);
  } catch {
    threw = true;
  }
  ok(threw, "different salt rejects the file");
}

section("[codec] plain codec round trip");
{
  const codec = createPlainCodec<{ a: string }>();
  const bytes = await codec.encode({ a: "hi" });
  ok(!isEncryptedFile(bytes), "plain file not flagged encrypted");
  eq((await codec.decode(bytes)).a, "hi", "plain decode");
}

// ---------------------------------------------------------------------------
section("[fx] parse + overrides + rebase");
{
  const fx = parseErApi({ result: "success", base_code: "USD", rates: { USD: 1, INR: 80, CLP: 950 } });
  eq(fx.base, "USD", "base USD");
  eq(fx.rates.INR, 80, "INR rate parsed");

  let threw = false;
  try {
    parseErApi({ result: "error" });
  } catch {
    threw = true;
  }
  ok(threw, "error payload throws");

  const over = withOverrides(fx, { INR: 83 });
  eq(over.rates.INR, 83, "override applied");
  eq(over.rates.CLP, 950, "non-overridden kept");

  const inInr = rebase(fx, "INR");
  eq(inInr.base, "INR", "rebased to INR");
  near(inInr.rates.USD, 1 / 80, 1e-9, "USD per INR = 1/80");
  near(inInr.rates.CLP, 950 / 80, 1e-9, "CLP per INR = 950/80");
}

// ---------------------------------------------------------------------------
section("[sync] latestSnapshot picks highest version");
{
  const metas: SnapshotMeta[] = [
    { id: "a", name: "pf-1", version: 3, author: "", deviceId: "", savedAt: "", schemaVersion: 1 },
    { id: "b", name: "pf-2", version: 9, author: "", deviceId: "", savedAt: "", schemaVersion: 1 },
    { id: "c", name: "pf-3", version: 5, author: "", deviceId: "", savedAt: "", schemaVersion: 1 },
  ];
  eq(latestSnapshot(metas)?.id, "b", "v9 wins");
  eq(snapshotName("2026-06-28T10:30:00.000Z"), "pf-2026-06-28T10-30-00-000Z.pfdb", "neutral name");
}

section("[sync] latestSnapshot tiebreaks equal versions by savedAt then id");
{
  const m = (id: string, version: number, savedAt: string): SnapshotMeta => ({
    id,
    name: "",
    version,
    author: "",
    deviceId: "",
    savedAt,
    schemaVersion: 1,
  });
  eq(
    latestSnapshot([m("a", 5, "2026-01-01T00:00:00Z"), m("b", 5, "2026-02-01T00:00:00Z"), m("c", 3, "")])?.id,
    "b",
    "equal version → later savedAt wins (deterministic)",
  );
}

section("[sync] engine: create-once-then-update per session, load latest");
{
  // Minimal in-memory provider.
  const files = new Map<string, { meta: SnapshotMeta; bytes: Uint8Array }>();
  let seq = 0;
  const provider: SyncProvider = {
    async list() {
      return [...files.values()].map((f) => f.meta);
    },
    async download(id) {
      return files.get(id)!.bytes;
    },
    async create(meta, data) {
      const id = `f${++seq}`;
      const full = { ...meta, id };
      files.set(id, { meta: full, bytes: data });
      return full;
    },
    async update(id, meta, data) {
      const cur = files.get(id)!;
      files.set(id, { meta: { ...cur.meta, ...meta }, bytes: data });
    },
    async remove(id) {
      files.delete(id);
    },
  };

  interface Doc {
    version: number;
    data: Record<string, never>;
  }
  const engine = new SyncEngine<Doc>({
    provider,
    codec: createPlainCodec<Doc>(),
    versionOf: (d) => d.version,
    author: "me",
    deviceId: "dev1",
    schemaVersion: 1,
  });

  await engine.push({ version: 1, data: {} }, "2026-06-28T00:00:00.000Z", "2026-06-28T00:00:01.000Z");
  await engine.push({ version: 2, data: {} }, "2026-06-28T00:00:00.000Z", "2026-06-28T00:00:05.000Z");
  eq(files.size, 1, "one file per session (updated, not duplicated)");

  const loaded = await engine.loadLatest();
  eq(loaded?.doc.version, 2, "loadLatest returns the updated version");
  eq(loaded?.meta.version, 2, "meta version is 2");
}

section("[engine] prune keeps the newest N and protects the session file");
{
  const files = new Map<string, { meta: SnapshotMeta; bytes: Uint8Array }>();
  let seq = 0;
  const provider: SyncProvider = {
    async list() {
      return [...files.values()].map((f) => f.meta);
    },
    async download(id) {
      return files.get(id)!.bytes;
    },
    async create(meta, data) {
      const id = `f${++seq}`;
      files.set(id, { meta: { ...meta, id }, bytes: data });
      return { ...meta, id };
    },
    async update(id, meta, data) {
      const cur = files.get(id)!;
      files.set(id, { meta: { ...cur.meta, ...meta }, bytes: data });
    },
    async remove(id) {
      files.delete(id);
    },
  };
  // Seed 5 older snapshots (versions 1..5) from prior sessions.
  for (let v = 1; v <= 5; v++) {
    await provider.create(
      { name: `pf-v${v}.pfdb`, version: v, author: "me", deviceId: "dev1", savedAt: `t${v}`, schemaVersion: 1 },
      new Uint8Array(),
    );
  }
  interface Doc {
    version: number;
    data: Record<string, never>;
  }
  const engine = new SyncEngine<Doc>({
    provider,
    codec: createPlainCodec<Doc>(),
    versionOf: (d) => d.version,
    author: "me",
    deviceId: "dev1",
    schemaVersion: 1,
  });
  // This session pushes v6 (its own file).
  await engine.push({ version: 6, data: {} }, "2026-06-28T01:00:00.000Z", "2026-06-28T01:00:00.000Z");
  eq(files.size, 6, "6 files before prune");
  const removed = await engine.prune(3);
  eq(removed, 3, "removed the 3 oldest");
  eq(files.size, 3, "kept 3");
  const versions = [...files.values()].map((f) => f.meta.version).sort((a, b) => a - b);
  eq(versions.join(","), "4,5,6", "kept the newest 3 by version");

  // The current session file is never deleted, even when keep is tiny.
  const removed2 = await engine.prune(1);
  ok(
    [...files.values()].some((f) => f.meta.version === 6),
    "session file (v6) survives an aggressive prune",
  );
  ok(removed2 >= 1, "still prunes the others");

  // With onlyDeviceId set, a FOREIGN device's file is never deleted (it may hold
  // unmerged edits — older version ≠ contained in a kept file).
  await provider.create(
    { name: "pf-foreign.pfdb", version: 2, author: "x", deviceId: "devX", savedAt: "t0", schemaVersion: 1 },
    new Uint8Array(),
  );
  const before = files.size;
  const removed3 = await engine.prune(1, undefined, "dev1"); // keep top-1, own-only
  ok(
    [...files.values()].some((f) => f.meta.deviceId === "devX"),
    "foreign device's file is preserved",
  );
  ok(before - files.size === removed3, "removed count matches deletions");
}

// ---------------------------------------------------------------------------
// Envelope encryption (DEK wrapped by a passphrase-derived KEK in a keyring).
// See docs/MIGRATION_HISTORY.md. These cover the security-critical invariant:
// changing the password re-wraps the SAME DEK, so old files stay readable.
// ---------------------------------------------------------------------------
section("[envelope] DEK wrap → unwrap round trip");
{
  const kdf = newSalt();
  const kek = await deriveKey("family-pass", kdf);
  const dek = await generateDek();
  const wrapped = await wrapDek(kek, dek);
  const dek2 = await unwrapDek(kek, wrapped);
  const blob = await encryptBytes(dek, new TextEncoder().encode("hello"));
  const plain = new TextDecoder().decode(await decryptBytes(dek2, blob));
  eq(plain, "hello", "unwrapped DEK decrypts what the original DEK sealed");
}

section("[envelope] wrong passphrase can't unwrap the DEK");
{
  const kdf = newSalt();
  const dek = await generateDek();
  const wrapped = await wrapDek(await deriveKey("right", kdf), dek);
  let threw = false;
  try {
    await unwrapDek(await deriveKey("wrong", kdf), wrapped);
  } catch {
    threw = true;
  }
  ok(threw, "wrong KEK fails to unwrap (AES-GCM auth = the passphrase check)");
}

section("[envelope] pfdb-v2 codec round trip + format detection");
{
  const dek = await generateDek();
  const codec = createDekCodec<{ v: number }>(dek);
  const bytes = await codec.encode({ v: 11 });
  ok(isEncryptedFile(bytes), "isEncryptedFile detects a v2 file");
  eq(encryptedFormat(bytes), "pfdb-v2", "encryptedFormat reports v2");
  eq((await codec.decode(bytes)).v, 11, "decodes the value");
}

section("[envelope] CHANGING the password keeps old snapshots readable");
{
  const dek = await generateDek();
  const snapshot = await createDekCodec<{ v: number }>(dek).encode({ v: 42 });
  // keyring v1 under password A, then "change password" = re-wrap the SAME DEK
  // under password B with a fresh salt.
  const kdfA = newSalt();
  const wrappedA = await wrapDek(await deriveKey("passA", kdfA), dek);
  const kdfB = newSalt();
  const wrappedB = await wrapDek(await deriveKey("passB", kdfB), dek);
  const dekB = await unwrapDek(await deriveKey("passB", kdfB), wrappedB);
  eq(
    (await createDekCodec<{ v: number }>(dekB).decode(snapshot)).v,
    42,
    "snapshot written before the change is still readable after it",
  );
  let threw = false;
  try {
    await unwrapDek(await deriveKey("passA", kdfB), wrappedB);
  } catch {
    threw = true;
  }
  ok(threw, "old password can't unwrap the new keyring");
  const dekA = await unwrapDek(await deriveKey("passA", kdfA), wrappedA);
  eq(
    (await createDekCodec<{ v: number }>(dekA).decode(snapshot)).v,
    42,
    "the original (immutable) keyring still opens the same DEK",
  );
}

section("[envelope] concurrent re-key: two keyrings wrap the SAME DEK → both open it");
{
  const dek = await generateDek();
  const snapshot = await createDekCodec<{ v: number }>(dek).encode({ v: 7 });
  const kdf1 = newSalt();
  const kdf2 = newSalt();
  const kr1 = await wrapDek(await deriveKey("newpass", kdf1), dek); // device 1's re-key
  const kr2 = await wrapDek(await deriveKey("newpass", kdf2), dek); // device 2's re-key (same pass)
  const d1 = await unwrapDek(await deriveKey("newpass", kdf1), kr1);
  const d2 = await unwrapDek(await deriveKey("newpass", kdf2), kr2);
  eq((await createDekCodec<{ v: number }>(d1).decode(snapshot)).v, 7, "device 1's keyring opens the data");
  eq((await createDekCodec<{ v: number }>(d2).decode(snapshot)).v, 7, "device 2's keyring opens the same data");
}

section("[keyring] validate / parse / encode round trip + rejects malformed");
{
  const kdf = newSalt();
  const dek = await generateDek();
  const wrappedDEK = await wrapDek(await deriveKey("p", kdf), dek);
  const good = { format: KEYRING_FORMAT, version: 3, dekId: "dek-abc", kdf, wrappedDEK };
  const bytes = encodeKeyring(validateKeyring(good));
  ok(isKeyringFile(bytes), "isKeyringFile detects a keyring");
  const back = parseKeyring(bytes);
  eq(back.version, 3, "version round-trips");
  eq(back.dekId, "dek-abc", "dekId round-trips");
  const bad: [string, unknown][] = [
    ["bad format", { ...good, format: "nope" }],
    ["non-finite version", { ...good, version: Number.NaN }],
    ["empty dekId", { ...good, dekId: "" }],
    ["missing wrappedDEK", { ...good, wrappedDEK: undefined }],
    ["missing kdf", { ...good, kdf: undefined }],
    // Hardened checks (a structurally-valid but corrupt keyring must NOT pass, or
    // it later throws an uncaught error in deriveKey/decrypt → cryptic lockout):
    ["zero iterations", { ...good, kdf: { ...kdf, iterations: 0 } }],
    ["fractional iterations", { ...good, kdf: { ...kdf, iterations: 1.5 } }],
    ["non-base64 salt", { ...good, kdf: { ...kdf, salt: "@@@@" } }],
    ["non-base64 wrappedDEK", { ...good, wrappedDEK: { iv: "!!", ciphertext: "!!" } }],
  ];
  for (const [label, b] of bad) {
    let threw = false;
    try {
      validateKeyring(b);
    } catch {
      threw = true;
    }
    ok(threw, `rejects ${label}`);
  }
}

section("[backup] self-contained v2 backup: a fresh device restores with just the passphrase");
{
  const dek = await generateDek();
  const kdf = newSalt();
  const wrappedDEK = await wrapDek(await deriveKey("backup-pass", kdf), dek);
  const bytes = await encodeBackup(dek, { v: 99 }, { dekId: "dek-xyz", kdf, wrappedDEK });
  ok(isEncryptedFile(bytes), "backup is an encrypted file");
  eq(encryptedFormat(bytes), "pfdb-v2", "backup is v2");
  const embedded = readEmbeddedKeyring(bytes);
  ok(embedded !== null, "backup embeds its keyring");
  eq(embedded!.dekId, "dek-xyz", "backup preserves the DEK identity (no spurious rotation on restore)");
  const dek2 = await unwrapDek(await deriveKey("backup-pass", embedded!.kdf), embedded!.wrappedDEK);
  eq(
    (await createDekCodec<{ v: number }>(dek2).decode(bytes)).v,
    99,
    "restored on a fresh device with only the passphrase",
  );
  eq(
    readEmbeddedKeyring(await createDekCodec<{ v: number }>(dek).encode({ v: 99 })),
    null,
    "a plain folder snapshot embeds no keyring",
  );
  // A corrupt embedded keyring (missing iterations) must read as null, not crash
  // downstream on embedded.kdf.
  const corrupt = new TextEncoder().encode(
    JSON.stringify({ format: "pfdb-v2", iv: "AA==", ciphertext: "AA==", keyring: { kdf: { salt: "AA==" }, wrappedDEK: { iv: "AA==", ciphertext: "AA==" } } }),
  );
  eq(readEmbeddedKeyring(corrupt), null, "malformed embedded keyring → null (no crash)");
}

section("[compat] v2 reader still reads legacy pfdb-v1");
{
  const kdf = newSalt();
  const key = await deriveKey("legacy", kdf);
  const v1 = await createEncryptedCodec<{ v: number }>(key, kdf).encode({ v: 5 });
  ok(isEncryptedFile(v1), "v1 detected as encrypted");
  eq(encryptedFormat(v1), "pfdb-v1", "encryptedFormat reports v1");
  eq((await createEncryptedCodec<{ v: number }>(key, kdf).decode(v1)).v, 5, "v1 still decodes");
}

done();
