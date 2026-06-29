// End-to-end backup/restore round-trip tests. These guard the single most
// safety-critical promise the app makes: "with the right password, a backup
// file always restores to exactly the data you had — and a wrong password or a
// corrupted file fails loudly rather than restoring garbage."
//
// They exercise the WHOLE pipeline the UI uses, not just the pieces:
//   store(real data) → exportDocument → codec.encode (.pfdb bytes)
//   → [fresh device] derive key from the file's OWN header → codec.decode
//   → applyDocument → exportDocument → assert byte-identical.
//
// Runs against the in-memory adapter (Node has no IndexedDB), which mirrors the
// IndexedDB adapter's import/export semantics. WebCrypto is real (Node 18+).

import { createMemoryStorage } from "../src/lib/storage/memory-adapter";
import { SCHEMA } from "../src/features/portfolio/model/schema";
import { createPortfolioStore, type PortfolioStore } from "../src/features/portfolio/state/store";
import { newSalt, deriveKey } from "../src/lib/crypto/vault";
import { createEncryptedCodec, createPlainCodec } from "../src/lib/crypto/codec";
import type { SnapshotDoc } from "../src/features/portfolio/model/types";
import { done, ok, section } from "./_harness";

// The collections a snapshot actually carries (settings + fxRates are
// device-local and intentionally stripped from backups). Canonicalise by
// sorting each collection by id so the compare is order-independent.
const SYNCED = ["people", "accounts", "categories", "transactions", "holdings", "holdingEvents"];
const canon = (data: Record<string, unknown[]>): string => {
  const out: Record<string, unknown[]> = {};
  for (const k of SYNCED) {
    const rows = [...((data[k] as Array<{ id: string }>) ?? [])];
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out[k] = rows;
  }
  return JSON.stringify(out);
};

// A deliberately messy but realistic dataset: multiple currencies, an archived
// row, a transfer, optional fields present and absent, a high-precision unit
// count, and a note with unicode + quotes + backslashes (the classic
// serialisation tripwires).
async function seed(): Promise<PortfolioStore> {
  const store = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await store.savePerson({ id: "p1", name: "Priya ₹" });
  await store.savePerson({ id: "p2", name: "Family 👪" });
  await store.saveAccount({ id: "A1", name: "HDFC", type: "bank", currency: "INR", personId: "p1" });
  await store.saveAccount({ id: "A2", name: "Schwab", type: "brokerage", currency: "USD", personId: "shared" });
  await store.saveAccount({ id: "A3", name: "Loan", type: "liability", currency: "INR", personId: "p1", archived: true });
  await store.saveCategory({ id: "food", name: "Food & Groceries", kind: "expense" });
  await store.saveCategory({ id: "groc", name: "Groceries", kind: "expense", parentId: "food" });
  await store.saveTransaction({
    id: "t1", date: "2026-01-15", type: "expense", accountId: "A1", personId: "p1",
    amount: 1234.56, currency: "INR", categoryId: "groc", note: 'lunch — café ☕ "quoted", \\backslash\\', updatedAt: "",
  });
  await store.saveTransaction({
    id: "t2", date: "2026-02-01", type: "transfer", accountId: "A2", personId: "shared",
    amount: 1000, currency: "USD", transferToAccountId: "A1", updatedAt: "",
  });
  await store.saveHolding({
    id: "H1", name: "VWRA ETF", personId: "shared", accountId: "A2",
    assetClass: "equity", currency: "USD", incomeMode: "accumulating",
  });
  await store.saveHoldingEvent({ id: "e1", holdingId: "H1", date: "2025-01-01", type: "opening", units: 10, amount: 5000 });
  await store.saveHoldingEvent({ id: "e2", holdingId: "H1", date: "2025-06-01", type: "buy", units: 0.123456789, price: 520.5, fee: 1.99 });
  await store.saveHoldingEvent({ id: "e3", holdingId: "H1", date: "2026-03-01", type: "dividend", amount: 12.34 });
  await store.saveHoldingEvent({ id: "e4", holdingId: "H1", date: "2026-06-28", type: "valuation", amount: 9999.99 });
  return store;
}

// ---------------------------------------------------------------------------
section("[backup] encrypted backup → fresh-device restore is lossless");
{
  const doc = await (await seed()).exportDocument();

  const kdf = newSalt();
  const bytes = await createEncryptedCodec<SnapshotDoc>(await deriveKey("correct horse battery staple", kdf), kdf).encode(doc);

  // Disaster recovery on a clean browser: no open vault, so we must derive the
  // key from the salt the FILE carries in its own cleartext header.
  const header = JSON.parse(new TextDecoder().decode(bytes)) as { kdf: { salt: string; iterations: number } };
  ok(header.kdf?.salt === kdf.salt, "file carries its own KDF salt in the cleartext header");
  const restored = await createEncryptedCodec<SnapshotDoc>(
    await deriveKey("correct horse battery staple", header.kdf),
    header.kdf,
  ).decode(bytes);

  const fresh = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await fresh.applyDocument(restored, { dirty: true });
  const reexported = await fresh.exportDocument();

  ok(canon(doc.data) === canon(reexported.data), "restored portfolio data is byte-identical to the original");
  const ev = (reexported.data.holdingEvents as Array<{ id: string; units?: number }>).find((e) => e.id === "e2");
  ok(ev?.units === 0.123456789, "fractional units preserved to full precision");
  const tx = (reexported.data.transactions as Array<{ id: string; note?: string }>).find((t) => t.id === "t1");
  ok(tx?.note === 'lunch — café ☕ "quoted", \\backslash\\', "unicode + quotes + backslashes in note preserved exactly");
}

section("[backup] plaintext backup (no password) round-trips identically");
{
  const doc = await (await seed()).exportDocument();
  const bytes = await createPlainCodec<SnapshotDoc>().encode(doc);
  const restored = await createPlainCodec<SnapshotDoc>().decode(bytes);
  const fresh = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await fresh.applyDocument(restored, { dirty: true });
  ok(canon(doc.data) === canon((await fresh.exportDocument()).data), "plaintext restore is byte-identical");
}

section("[backup] wrong password fails loudly (never restores garbage)");
{
  const doc = await (await seed()).exportDocument();
  const kdf = newSalt();
  const bytes = await createEncryptedCodec<SnapshotDoc>(await deriveKey("right-pass", kdf), kdf).encode(doc);
  let threw = false;
  try {
    await createEncryptedCodec<SnapshotDoc>(await deriveKey("wrong-pass", kdf), kdf).decode(bytes);
  } catch {
    threw = true;
  }
  ok(threw, "wrong password throws (AES-GCM auth tag rejects it) instead of returning corrupt data");
}

section("[backup] a corrupted/tampered file is detected, not silently restored");
{
  const doc = await (await seed()).exportDocument();
  const kdf = newSalt();
  const key = await deriveKey("pass", kdf);
  const bytes = await createEncryptedCodec<SnapshotDoc>(key, kdf).encode(doc);
  // Flip one character of the base64 ciphertext.
  const obj = JSON.parse(new TextDecoder().decode(bytes)) as { ciphertext: string };
  const c = obj.ciphertext;
  obj.ciphertext = c.slice(0, -2) + (c.slice(-2, -1) === "A" ? "B" : "A") + c.slice(-1);
  const tampered = new TextEncoder().encode(JSON.stringify(obj));
  let threw = false;
  try {
    await createEncryptedCodec<SnapshotDoc>(key, kdf).decode(tampered);
  } catch {
    threw = true;
  }
  ok(threw, "a single flipped ciphertext byte makes decrypt throw — the format is self-verifying");
}

section("[backup] restore REPLACES local data — no stale rows survive");
{
  const doc = await (await seed()).exportDocument();
  // A target device already holding DIFFERENT data; restoring must not merge.
  const target = await createPortfolioStore(createMemoryStorage(SCHEMA));
  await target.savePerson({ id: "zzz", name: "stale-should-be-gone" });
  await target.saveAccount({ id: "ZZ", name: "stale", type: "cash", currency: "USD", personId: "shared" });
  await target.applyDocument(doc, { dirty: true });
  const after = await target.exportDocument();
  const peopleIds = (after.data.people as Array<{ id: string }>).map((p) => p.id);
  ok(!peopleIds.includes("zzz"), "pre-existing 'zzz' person was cleared by the replace");
  ok(canon(doc.data) === canon(after.data), "target now exactly equals the restored backup");
}

done();
