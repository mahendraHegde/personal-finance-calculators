// Human-readable naming and value formatting shared by the sync dialogs (DiffModal and
// MergeModal). Kept in its own module so BOTH dialogs describe the same data the same way —
// the alternative had one calling a collection "HoldingEvents" and the other "investment
// transactions" — and so the component files export only components (fast refresh).

import type { Keyed } from "../../../lib/sync/diff";
import { formatMoneyExact, parseStoredDate } from "../../../lib/util/format";

/** Human names for the storage collections — "transactions", not "txn rows". */
const COLLECTION_LABEL: Record<string, { one: string; many: string }> = {
  transactions: { one: "transaction", many: "transactions" },
  accounts: { one: "account", many: "accounts" },
  categories: { one: "category", many: "categories" },
  people: { one: "person", many: "people" },
  holdings: { one: "investment", many: "investments" },
  holdingEvents: { one: "investment transaction", many: "investment transactions" },
  fxRates: { one: "exchange-rate snapshot", many: "exchange-rate snapshots" },
  settings: { one: "setting", many: "settings" },
};
export const label = (collection: string, n: number): string => {
  const l = COLLECTION_LABEL[collection] ?? { one: collection, many: collection };
  return n === 1 ? l.one : l.many;
};
/** Plural human name for a collection, shared with DiffModal so the same data isn't called
 *  "HoldingEvents" in one dialog and "investment transactions" in the next. */
export const collectionLabel = (collection: string): string => label(collection, 2);

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One-line human description of a record: what it IS, not which fields it has.
 *
 *  This is the line the user reads to decide WHICH record a choice is about, so it has to
 *  separate two records the app itself lets you name identically: each person's "IBKR", a
 *  "Misc" under Food and another under Travel, two "HDFC Fixed Deposit"s. Two conflict rows
 *  headed by the same text are undecidable no matter how good the values below them are —
 *  hence the owner, and the parent path, come from the RECORD (truthful per side) with the
 *  resolver used only to name what the record points AT. */
export function describe(collection: string, rec: Keyed, ctx: DisplayContext): string {
  const r = rec as unknown as Record<string, unknown>;
  const resolve = ctx.name;
  const ownerName = (): string => {
    const id = str(r.personId);
    if (!id) return "";
    if (id === SHARED_OWNER) return "Shared";
    return resolve("people", id) ?? "";
  };
  switch (collection) {
    case "transactions": {
      const amount = num(r.amount);
      const money = amount !== null ? money_(amount, rec, ctx) : "";
      const what = str(r.note) || str(r.type);
      return [str(r.date), money, what].filter(Boolean).join(" · ");
    }
    case "holdingEvents": {
      // The INVESTMENT it belongs to is the identifying fact — a buy/sell has no `amount`
      // (money is units × price), so date+type alone couldn't tell a VOO buy from an FD.
      const holding = resolve("holdings", str(r.holdingId));
      const amount = num(r.amount);
      const units = num(r.units);
      // Formatted, and in the PARENT HOLDING's currency — an event carries none of its own, so
      // the header used to show a bare "505000.5" next to a card reading "US$505,000.50".
      const detail = amount !== null ? money_(amount, rec, ctx) : units !== null ? `${units} units` : "";
      return [holding ?? "(unknown investment)", str(r.date), str(r.type), detail].filter(Boolean).join(" · ");
    }
    case "accounts":
      return [str(r.name), str(r.currency), ownerName()].filter(Boolean).join(" · ");
    case "holdings":
      return [str(r.name), str(r.ticker), ownerName()].filter(Boolean).join(" · ");
    case "categories": {
      // "Food › Misc", so the two Misc categories aren't one indistinguishable row twice.
      const parent = r.parentId ? resolve("categories", str(r.parentId)) : undefined;
      const name = str(r.name) || str(r.id);
      return parent ? `${parent} › ${name}` : name;
    }
    default:
      return str(r.name) || str(r.label) || str(r.id);
  }
}

/** The currency a record's money is in.
 *
 *  A `HoldingEvent` has NO currency field — its money is in the parent `Holding`'s currency —
 *  so defaulting to USD rendered an INR deposit's ₹505,000 as "US$505,000" (~87× overstated),
 *  on both option cards of a conflict and in every pull's diff. When no currency can be
 *  established we format the number WITHOUT a symbol rather than assert a false one. */
function currencyOf(rec: Keyed, ctx: DisplayContext): string | undefined {
  const r = rec as unknown as Record<string, unknown>;
  const own = str(r.currency);
  if (own) return own;
  const holdingId = str(r.holdingId);
  if (holdingId) {
    const holding = ctx.record("holdings", holdingId) as unknown as Record<string, unknown> | undefined;
    const parent = str(holding?.currency);
    if (parent) return parent;
  }
  return undefined;
}

/** Money for a comparison, in the record's real currency — or plainly, with none claimed. */
export function money_(amount: number, rec: Keyed, ctx: DisplayContext): string {
  const ccy = currencyOf(rec, ctx);
  return ccy ? formatMoneyExact(amount, ccy) : amount.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Plain-language field names. Anything not listed is humanised generically rather than
 *  leaking camelCase at the user ("openingBalance" → "opening balance"). */
const FIELD_LABEL: Record<string, string> = {
  openingBalance: "opening balance",
  openingBalanceDate: "opening balance date",
  assetClass: "type",
  incomeMode: "dividend handling",
  priceSource: "price source",
  units: "units",
  price: "price",
  fee: "fee",
  color: "colour",
  interest: "interest settings",
  autopay: "auto-pay settings",
  fd: "deposit terms",
  holdingId: "investment",
  createdAt: "recorded time",
  ref: "reference",
  amount: "amount",
  date: "date",
  note: "note",
  categoryId: "category",
  accountId: "account",
  personId: "owner",
  type: "type",
  currency: "currency",
  name: "name",
  transferToAccountId: "transfer destination",
  transferToAmount: "received amount",
  // Noun phrases only. A verb phrase turns "differs in the amount and counts in reports but
  // not balances" into a sentence that asserts something about the record, and then reads as
  // its own negation next to a "no".
  excludeFromBalance: "excluded from balances",
  excludeFromReports: "excluded from reports",
  archived: "archived",
  parentId: "parent category",
  ticker: "ticker",
  updatedAt: "last-edited time",
  author: "edited by",
};
/** camelCase → words, as a fallback so no raw field name ever reaches the user. */
export const humanField = (f: string): string =>
  FIELD_LABEL[f] ?? f.replace(/Id$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

export function describeChanges(fields: string[]): string {
  const named = fields.map(humanField);
  if (named.length === 0) return "details";
  if (named.length === 1) return `the ${named[0]}`;
  return `the ${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/** Which collection an id-valued field points at, so a raw UUID can be shown as a name. */
const REF_COLLECTION: Record<string, string> = {
  categoryId: "categories",
  parentId: "categories",
  accountId: "accounts",
  transferToAccountId: "accounts",
  fromAccountId: "accounts",
  personId: "people",
  holdingId: "holdings",
};

/** Machine timestamps — shown as a readable moment rather than an ISO string. */
const TIMESTAMP_FIELDS = new Set(["updatedAt", "createdAt", "savedAt"]);

/** Fields stored as an explicit boolean, so an ABSENT value means "no" rather than "missing". */
const BOOLEAN_FIELDS = new Set(["archived", "excludeFromBalance", "excludeFromReports", "dueNextMonth"]);

/** The shared-owner sentinel. It is a VALUE, not a `people` row, so looking it up in the
 *  records would report "(no longer exists)" — false, and it would push the user to adopt the
 *  other side, silently re-owning a shared item. Every transfer and every imported row with no
 *  named owner carries it. */
const SHARED_OWNER = "shared";

/** Looks a record up by collection + id. Supplied by the caller (the merge plan, or local
 *  state + the incoming snapshot) so this module needs no store access. */
export type RecordResolver = (collection: string, id: string) => Keyed | undefined;
/** Turns an id into something a human recognises. */
export type NameResolver = (collection: string, id: string) => string | undefined;

/** Everything the value formatter needs to make a value readable. */
export interface DisplayContext {
  name: NameResolver;
  record: RecordResolver;
}

/** Build the name resolver used throughout both dialogs.
 *
 *  Two rules that matter for decidability:
 *   - a category shows its parent path ("Food › Dining"), so a bare "Misc" isn't ambiguous;
 *   - an account shows its OWNER, because the app's own rule is that same-named accounts
 *     (each person's "IBKR") must be told apart everywhere they appear — without it the two
 *     option cards can render identically and there is nothing to choose between. */
export function makeNameResolver(record: RecordResolver): NameResolver {
  return (collection, id) => {
    if (collection === "people" && id === SHARED_OWNER) return "Shared";
    const rec = record(collection, id) as unknown as Record<string, unknown> | undefined;
    if (!rec) return undefined;
    const name = str(rec.name);
    if (!name) return undefined;
    if (collection === "categories" && rec.parentId) {
      const parent = record("categories", str(rec.parentId)) as unknown as Record<string, unknown> | undefined;
      if (parent) return `${str(parent.name)} › ${name}`;
    }
    if (collection === "accounts") {
      const owner = rec.personId === SHARED_OWNER ? "Shared" : undefined;
      const person = owner ?? (rec.personId ? str((record("people", str(rec.personId)) as unknown as Record<string, unknown> | undefined)?.name ?? "") : "");
      const ccy = str(rec.currency);
      const extra = [ccy, person].filter(Boolean).join(" · ");
      return extra ? `${name} (${extra})` : name;
    }
    return name;
  };
}

/** Render a field VALUE for display. The two sides must not only DIFFER textually, they must
 *  be understandable: an id shown as a UUID is as undecidable as showing nothing.
 *
 *  `otherValue` (the same field on the OTHER side) is used only to render nested objects: the
 *  union of both sides' keys, so a sub-field present on one side only still shows as "no"
 *  instead of silently vanishing from the comparison. */
export function showValue(
  field: string,
  value: unknown,
  rec: Keyed,
  ctx: DisplayContext,
  otherValue?: unknown,
): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value === undefined || value === null || value === "") {
    return BOOLEAN_FIELDS.has(field) ? "no" : "— none —";
  }
  if (typeof value === "number") {
    if (field === "amount" || field === "openingBalance") {
      // EXACT, not display-rounded: this number is being chosen, not read. And in the record's
      // OWN currency, resolved through the parent holding when the record carries none.
      return money_(value, rec, ctx);
    }
    if (field === "transferToAmount") {
      // This one is in the DESTINATION account's currency, not the record's — formatting it
      // with the source currency states a false amount (₹600 for a US$600 credit).
      const destId = str((rec as unknown as Record<string, unknown>).transferToAccountId);
      const dest = destId ? (ctx.record("accounts", destId) as unknown as Record<string, unknown> | undefined) : undefined;
      return formatMoneyExact(value, str(dest?.currency) || str((rec as unknown as Record<string, unknown>).currency) || "USD");
    }
    return String(value);
  }
  if (typeof value === "string") {
    // A machine timestamp → a readable moment. `updatedAt` reaches the DIFF dialog (which,
    // unlike the merge planner, doesn't exclude bookkeeping), so a raw
    // "2026-07-17T08:00:00.000Z" would otherwise be shown on the path of every pull.
    if (TIMESTAMP_FIELDS.has(field)) {
      const d = parseStoredDate(value);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleString(undefined, {
          year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        });
      }
    }
    // An id → the NAME. This is the difference between "choose between two UUIDs" and
    // "choose between Groceries and Travel", which is the whole point of the screen.
    const target = REF_COLLECTION[field];
    if (target) return ctx.name(target, value) ?? "(no longer exists)";
    return value;
  }
  if (typeof value === "object") {
    // Nested settings (auto-pay, interest, deposit terms) — readable pairs, not JSON, with any
    // ids inside them resolved, and keys unioned across both sides (see `otherValue`).
    const self = value as Record<string, unknown>;
    const other = (otherValue && typeof otherValue === "object" ? otherValue : {}) as Record<string, unknown>;
    // EVERY key either side has, absent ones included: clearing an FD's maturity date is a
    // change to how it accrues, and filtering absent keys out reduced that to a phrase
    // quietly missing from one card — a difference the user cannot see.
    const keys = [...new Set([...Object.keys(self), ...Object.keys(other)])].sort();
    const entries = keys.map((k) => `${humanField(k)} ${showValue(k, self[k], rec, ctx)}`);
    return entries.length > 0 ? entries.join(", ") : "— none —";
  }
  return String(value);
}
