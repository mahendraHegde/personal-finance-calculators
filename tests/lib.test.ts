// Tests for the reusable lib layer: storage adapter contract, XIRR, currency
// conversion, and dataset diff. Run with tsx (see package.json).

import { createMemoryStorage } from "../src/lib/storage/memory-adapter";
import type { Entity, StorageSchema } from "../src/lib/storage/types";
import { xirr } from "../src/lib/money/xirr";
import { convert, sumInBase, toBase } from "../src/lib/money/currency";
import { diffCollections, diffDatasets } from "../src/lib/sync/diff";
import { formatCompactMoney, formatMoney, parseStoredDate } from "../src/lib/util/format";
import { done, eq, near, ok, section } from "./_harness";

interface Txn extends Entity {
  personId: string;
  date: string;
  amount: number;
}

const schema: StorageSchema = {
  version: 1,
  collections: [
    {
      name: "txns",
      indexes: [
        { name: "date", keyPath: "date" },
        { name: "person_date", keyPath: ["personId", "date"] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
section("[storage] CRUD + count");
{
  const s = createMemoryStorage(schema);
  const c = s.collection<Txn>("txns");
  await c.put({ id: "a", personId: "p1", date: "2024-01-03", amount: 10 });
  await c.put({ id: "b", personId: "p1", date: "2024-01-01", amount: 20 });
  await c.put({ id: "c", personId: "p2", date: "2024-01-02", amount: 30 });
  eq(await c.count(), 3, "count = 3");
  const got = await c.get("b");
  eq(got?.amount, 20, "get by id");
  await c.delete("c");
  eq(await c.count(), 2, "count after delete = 2");
}

section("[storage] getAll ordered by index");
{
  const s = createMemoryStorage(schema);
  const c = s.collection<Txn>("txns");
  await c.putMany([
    { id: "a", personId: "p1", date: "2024-01-03", amount: 1 },
    { id: "b", personId: "p1", date: "2024-01-01", amount: 2 },
    { id: "c", personId: "p1", date: "2024-01-02", amount: 3 },
  ]);
  const all = await c.getAll({ index: "date" });
  eq(all.map((x) => x.id).join(","), "b,c,a", "ordered ascending by date index");
}

section("[storage] index range filter");
{
  const s = createMemoryStorage(schema);
  const c = s.collection<Txn>("txns");
  await c.putMany([
    { id: "a", personId: "p1", date: "2024-01-01", amount: 1 },
    { id: "b", personId: "p2", date: "2024-01-01", amount: 2 },
    { id: "c", personId: "p1", date: "2024-02-01", amount: 3 },
  ]);
  const p1 = await c.getAll({
    index: "person_date",
    lower: ["p1", ""],
    upper: ["p1", "￿"],
  });
  eq(p1.length, 2, "person_date range returns p1's 2 rows");
  ok(
    p1.every((x) => x.personId === "p1"),
    "all rows belong to p1",
  );
}

section("[storage] keyset pagination");
{
  const s = createMemoryStorage(schema);
  const c = s.collection<Txn>("txns");
  for (let i = 1; i <= 5; i++) {
    await c.put({ id: `t${i}`, personId: "p", date: `2024-01-0${i}`, amount: i });
  }
  const range = { index: "person_date", lower: ["p", ""], upper: ["p", "￿"] };
  const page1 = await c.page({ ...range, limit: 2 });
  eq(page1.items.map((x) => x.id).join(","), "t1,t2", "page 1");
  ok(!page1.done, "page 1 not done");
  const page2 = await c.page({ ...range, limit: 2, after: page1.nextCursor });
  eq(page2.items.map((x) => x.id).join(","), "t3,t4", "page 2 via cursor");
  const page3 = await c.page({ ...range, limit: 2, after: page2.nextCursor });
  eq(page3.items.map((x) => x.id).join(","), "t5", "page 3 remainder");
  ok(page3.done, "page 3 done");
}

section("[storage] pagination does not skip rows sharing an index key");
{
  const s = createMemoryStorage(schema);
  const c = s.collection<Txn>("txns");
  await c.putMany([
    { id: "a", personId: "p", date: "2024-01-01", amount: 1 }, // same date as b
    { id: "b", personId: "p", date: "2024-01-01", amount: 2 },
    { id: "c", personId: "p", date: "2024-01-02", amount: 3 },
  ]);
  const range = { index: "person_date", lower: ["p", ""], upper: ["p", "￿"] } as const;
  const seen: string[] = [];
  let cursor: { key: (string | number)[]; id: string } | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const pg = await c.page({ ...range, limit: 1, after: cursor });
    seen.push(...pg.items.map((x) => x.id));
    if (pg.done) break;
    cursor = pg.nextCursor as typeof cursor;
  }
  eq([...seen].sort().join(","), "a,b,c", "all 3 rows returned (no dup-key skip)");
}

section("[storage] exportAll / importAll replace");
{
  const s = createMemoryStorage(schema);
  const c = s.collection<Txn>("txns");
  await c.putMany([
    { id: "a", personId: "p1", date: "2024-01-01", amount: 1 },
    { id: "b", personId: "p1", date: "2024-01-02", amount: 2 },
  ]);
  const snap = await s.exportAll();
  eq(snap.txns.length, 2, "export captured 2 rows");

  const s2 = createMemoryStorage(schema);
  await s2.importAll(snap, "replace");
  eq(await s2.collection<Txn>("txns").count(), 2, "import restored rows");
}

// ---------------------------------------------------------------------------
// XIRR uses Excel's actual/365 day count, so we span a non-leap year (2021 →
// 2022 is exactly 365 days) to compare against clean closed-form expectations.
section("[xirr] doubling over exactly one year = 100%");
{
  const r = xirr([
    { date: "2021-01-01", amount: -1000 },
    { date: "2022-01-01", amount: 2000 },
  ]);
  near(r ?? NaN, 1.0, 1e-4, "100% return");
}

section("[xirr] +10% over one year");
{
  const r = xirr([
    { date: "2021-01-01", amount: -1000 },
    { date: "2022-01-01", amount: 1100 },
  ]);
  near(r ?? NaN, 0.1, 1e-4, "10% return");
}

section("[xirr] not computable cases → null");
{
  eq(xirr([{ date: "2020-01-01", amount: -1000 }]), null, "single flow → null");
  eq(
    xirr([
      { date: "2020-01-01", amount: -1000 },
      { date: "2021-01-01", amount: -500 },
    ]),
    null,
    "no sign change → null",
  );
  // Zero-day span (all flows one date) → undefined IRR, regardless of net —
  // break-even is the sneaky one (constant-zero NPV must not return the guess).
  eq(
    xirr([
      { date: "2025-06-30", amount: -100 },
      { date: "2025-06-30", amount: 100 },
    ]),
    null,
    "0-day span, break-even → null (not the initial guess)",
  );
  eq(
    xirr([
      { date: "2025-06-30", amount: -100 },
      { date: "2025-06-30", amount: 110 },
    ]),
    null,
    "0-day span, gain → null",
  );
}

section("[xirr] invalid date fails closed (null, not an absurd rate)");
{
  eq(
    xirr([
      { date: "not-a-date", amount: -1000 },
      { date: "2021-01-01", amount: 1100 },
    ]),
    null,
    "bad date → null (not ~10000%)",
  );
  eq(
    xirr([
      { date: "", amount: -1000 },
      { date: "2021-01-01", amount: 1100 },
    ]),
    null,
    "empty date → null",
  );
}

// ---------------------------------------------------------------------------
section("[currency] convert across base");
{
  const fx = { base: "USD", rates: { INR: 80, CLP: 950 } };
  near(convert({ amount: 80, currency: "INR" }, "USD", fx), 1, 1e-9, "80 INR = 1 USD");
  near(convert({ amount: 1, currency: "USD" }, "INR", fx), 80, 1e-9, "1 USD = 80 INR");
  near(convert({ amount: 80, currency: "INR" }, "CLP", fx), 950, 1e-9, "80 INR = 950 CLP");
  near(toBase({ amount: 950, currency: "CLP" }, fx), 1, 1e-9, "950 CLP = 1 USD base");
  near(
    sumInBase([{ amount: 80, currency: "INR" }, { amount: 1, currency: "USD" }], fx),
    2,
    1e-9,
    "sum mixed currencies → 2 USD",
  );
}

section("[currency] missing rate throws");
{
  let threw = false;
  try {
    convert({ amount: 1, currency: "GBP" }, "USD", { base: "USD", rates: {} });
  } catch {
    threw = true;
  }
  ok(threw, "throws on unknown currency");
}

// ---------------------------------------------------------------------------
section("[diff] added / removed / modified");
{
  const local = [
    { id: "1", v: 10 },
    { id: "2", v: 20 },
  ];
  const remote = [
    { id: "1", v: 10 },
    { id: "2", v: 25 },
    { id: "3", v: 30 },
  ];
  const d = diffCollections(local, remote);
  eq(d.added.map((x) => x.id).join(","), "3", "added = [3]");
  eq(d.modified.length, 1, "1 modified");
  eq(d.modified[0]?.changes.join(","), "v", "changed field = v");
  eq(d.removed.length, 0, "nothing removed");
}

section("[diff] dataset summary");
{
  const d = diffDatasets(
    { txns: [{ id: "a" }] },
    { txns: [{ id: "a" }, { id: "b" }] },
  );
  eq(d.summary.added, 1, "summary.added = 1");
  ok(d.summary.changed, "summary.changed = true");
}

section("[storage] replace clears collections absent from the snapshot; preserve kept");
{
  const s = createMemoryStorage({
    version: 1,
    collections: [{ name: "a" }, { name: "b" }, { name: "keep" }],
  });
  await s.collection<Entity>("a").put({ id: "a1" });
  await s.collection<Entity>("b").put({ id: "b1" });
  await s.collection<Entity>("keep").put({ id: "k1" });
  // Snapshot mentions only "a"; "b" is omitted; "keep" is device-local.
  await s.importAll({ a: [{ id: "a2" }] }, "replace", { preserve: ["keep"] });
  eq((await s.collection<Entity>("a").getAll()).map((x) => x.id).join(","), "a2", "a replaced");
  eq(await s.collection<Entity>("b").count(), 0, "b cleared though absent from snapshot");
  eq(await s.collection<Entity>("keep").count(), 1, "preserved collection untouched");
}

section("[storage] batch is atomic (no partial apply on a bad op)");
{
  const s = createMemoryStorage({ version: 1, collections: [{ name: "x" }] });
  await s.collection<Entity>("x").put({ id: "x1" });
  let threw = false;
  try {
    await s.batch([
      { collection: "x", op: "put", value: { id: "x2" } },
      { collection: "nope", op: "put", value: { id: "z" } }, // unknown → whole batch rejected
    ]);
  } catch {
    threw = true;
  }
  ok(threw, "batch rejects on a bad op");
  eq(await s.collection<Entity>("x").count(), 1, "x2 not applied (atomic)");
}

section("[format] INR uses the Indian numbering system (Lakh/Crore + 2-2-3 grouping)");
{
  // Full form: Indian digit grouping, not Western thousands.
  eq(formatMoney(990755, "INR"), "₹9,90,755", "₹9,90,755 (not 990,755)");
  // Compact: Lakh / Crore, not K / M.
  const lakh = formatCompactMoney(990755, "INR");
  ok(lakh.includes("L") && !/[kKmM]/.test(lakh), `compact lakh: ${lakh}`);
  const crore = formatCompactMoney(12_345_678, "INR");
  ok(crore.includes("Cr"), `compact crore: ${crore}`);
}

section("[format] date-only strings parse in LOCAL time (no UTC off-by-one)");
{
  const d = parseStoredDate("2026-06-01");
  eq(d.getFullYear(), 2026, "year = 2026");
  eq(d.getMonth(), 5, "month = June (0-based 5)");
  eq(d.getDate(), 1, "day = 1, not the previous day");
}

done();
