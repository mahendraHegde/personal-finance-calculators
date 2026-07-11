// Credit-card statement auto-pay (opt-in, per card). We DON'T invent a new kind
// of record: a statement payment is just a `transfer` (payer → card), the same
// shape a user would enter by hand. This module derives the SET of transfers that
// *should* exist from each card's AutopayTerms + its real transactions; the store
// reconciles the stored transfers to match (create / update / delete by id). So
// the ledger, reports, and the savings-interest engine all see ordinary transfers
// with no special-casing.
//
// The payoff amount is the statement balance AS OF THE CLOSING DATE — not the
// card's live balance — so charges made after the statement closed (next cycle's)
// aren't paid early, and the payer's cash keeps earning interest until the due
// date. Netting across cycles uses an explicit running total of prior payoffs
// (NOT the payoff dates), so a due date that lands after the next statement closes
// (e.g. "pay the 15th of the next month") can't double-pay.

import type { FxTable } from "../../../lib/money/currency";
import { isoFromParts } from "../../../lib/util/date";
import type { Account, AutopayTerms, ID, Transaction } from "../model/types";
import { SHARED } from "../model/types";
import { accountTxnDelta } from "./networth";

/** Deterministic id for a card's payoff of the cycle closing on `closeDate`. Stable
 *  across devices (same cycle → same id → sync merges to one) and across reconciles
 *  (idempotent). The prefix marks a transaction as autopay-managed.
 *
 *  ⚠️ PERSISTED SCHEMA CONTRACT — treat this format like a DB migration. Everything
 *  hangs on two invariants: (a) this `autopay:{cardId}:{closeDate}` shape never
 *  changes, and (b) no hand-entered transaction id ever starts with `autopay:`.
 *  Change the format and every existing autopay transfer is orphaned under its old
 *  id on EVERY synced device — reconcile deletes each old-id row and recreates it
 *  under the new id, churning versions and briefly double-counting money-moving
 *  rows. Reuse the prefix for a second managed family and `isAutopayTransaction`
 *  will sweep those too. */
const AUTOPAY_PREFIX = "autopay:";
export function autopayId(cardId: ID, closeDate: string): string {
  return `${AUTOPAY_PREFIX}${cardId}:${closeDate}`;
}
export function isAutopayTransaction(t: Pick<Transaction, "id">): boolean {
  return t.id.startsWith(AUTOPAY_PREFIX);
}

/** Sorts before any real ISO date, so an opening balance with no explicit date is
 *  counted from the very start of the prefix-sum (not skipped). */
const EPOCH_SENTINEL = "0000-01-01";

interface Cycle {
  /** ISO date the statement closes. */
  close: string;
  /** ISO date payment is due (always strictly after `close`). */
  due: string;
}

/** The month after (year, month 1-12), rolling the year over at December. */
function nextMonth(year: number, month: number): [number, number] {
  return month >= 12 ? [year + 1, 1] : [year, month + 1];
}

/** Billing cycles whose statement has CLOSED (close in [since, asOf]), one per
 *  month, OLDEST FIRST. Day-of-month clamps to each month's length; the due date is
 *  pushed a month when it would otherwise fall on/before the close. Note this does
 *  NOT filter by due date — a closed statement not yet due is still returned (the
 *  store decides when to materialise it); that decoupling keeps the "should this
 *  payoff exist" decision independent of any one device's clock. */
function closedCycles(terms: AutopayTerms, asOf: string): Cycle[] {
  const sDay = terms.statementDay;
  const dDay = terms.dueDay;
  // Defensive: config from imported/older data might be out of range or malformed.
  // Bad days/months would flow into isoFromParts → Date.UTC(NaN) → a thrown
  // RangeError, so bail to "no cycles" instead.
  if (!Number.isInteger(sDay) || sDay < 1 || sDay > 31) return [];
  if (!Number.isInteger(dDay) || dDay < 1 || dDay > 31) return [];
  const [sy, sm] = terms.since.slice(0, 7).split("-").map(Number);
  const [ay, am] = asOf.slice(0, 7).split("-").map(Number);
  if (![sy, sm, ay, am].every(Number.isFinite)) return [];

  const out: Cycle[] = [];
  let y = sy;
  let m = sm;
  // The 1200-month cap is a pathological-input backstop, never hit in practice.
  for (let guard = 0; guard < 1200; guard++) {
    if (y > ay || (y === ay && m > am)) break;
    const close = isoFromParts(y, m, sDay);
    const [dueY, dueM] = terms.dueNextMonth ? nextMonth(y, m) : [y, m];
    let due = isoFromParts(dueY, dueM, dDay);
    // A due date on/before the close is impossible — roll it a month on.
    if (due <= close) {
      const [ny, nm] = nextMonth(dueY, dueM);
      due = isoFromParts(ny, nm, dDay);
    }
    if (close >= terms.since && close <= asOf) out.push({ close, due });
    [y, m] = nextMonth(y, m);
  }
  return out;
}

/** Round to whole minor units so tiny float residue in the summed balance doesn't
 *  churn the reconcile diff. Two decimals covers the currencies this app handles. */
function roundAmount(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The transfers that SHOULD exist for every card with auto-pay: one per CLOSED
 * billing cycle that owes something, moving that cycle's statement balance from the
 * payer to the card, dated at the due date. Derived purely from the card's config +
 * its REAL (non-autopay) transactions, so the result is deterministic and
 * independent of previously-generated rows.
 *
 * The card's balance at each cycle close is a single O(deltas) prefix-sum over the
 * card's own transactions (reusing `accountTxnDelta` for the sign rules) — NOT a
 * per-cycle full-ledger scan — so cost is linear in the ledger, not (cycles ×
 * ledger), which matters as history grows over years.
 *
 * `owed(cycle) = max(0, -(realBalanceAtClose + priorPaid))`, where `priorPaid` is
 * the running sum of earlier cycles' payoffs. Using a running total (rather than
 * the payoffs' dates) is what makes multi-cycle netting correct even when a payoff
 * is due after the next statement closes. A cycle owing nothing generates no
 * transfer. `updatedAt` is blank — the store stamps it on persist and ignores it
 * when diffing. Cards with no config / archived / a missing / different-currency /
 * self-referential payer are skipped (a transfer can't be mis-scaled or self-paid).
 */
export function desiredAutopayTransfers(
  accounts: Account[],
  transactions: Transaction[],
  asOf: string,
  fx?: FxTable,
): Transaction[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const real = transactions.filter((t) => !isAutopayTransaction(t));
  const out: Transaction[] = [];

  for (const card of accounts) {
    const terms = card.autopay;
    if (!terms || card.archived) continue;
    const payer = byId.get(terms.fromAccountId);
    if (!payer || payer.id === card.id || payer.currency !== card.currency) continue;

    const cycles = closedCycles(terms, asOf);
    if (cycles.length === 0) continue;

    // Build the card's dated balance changes once (opening balance + every real
    // transaction that touches it), then sweep them against the ascending cycle
    // closes to get the balance at each close in one linear pass.
    const deltas: { date: string; amt: number }[] = [];
    if (card.openingBalance) {
      deltas.push({ date: card.openingBalanceDate ?? EPOCH_SENTINEL, amt: card.openingBalance });
    }
    for (const t of real) {
      const d = accountTxnDelta(t, card, fx);
      if (d !== 0) deltas.push({ date: t.date, amt: d });
    }
    deltas.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let priorPaid = 0;
    let i = 0;
    let running = 0;
    for (const { close, due } of cycles) {
      while (i < deltas.length && deltas[i].date <= close) running += deltas[i++].amt;
      // Amount still owed on this statement = the debt at close, less what earlier
      // cycles' payoffs already covered.
      const owed = roundAmount(Math.max(0, -(running + priorPaid)));
      if (owed <= 0) continue;
      priorPaid += owed;
      out.push({
        id: autopayId(card.id, close),
        date: due,
        type: "transfer",
        accountId: payer.id,
        transferToAccountId: card.id,
        personId: SHARED, // transfers net within SHARED, matching manual transfers
        amount: owed,
        currency: card.currency,
        note: "Statement auto-pay",
        updatedAt: "",
      });
    }
  }
  return out;
}

/** True when a stored autopay transfer already matches its desired form (so the
 *  reconcile can skip re-writing it). Compares only the meaningful fields — never
 *  `updatedAt`/`author`, which change on every persist and would defeat idempotency. */
function autopayTransferMatches(stored: Transaction, desired: Transaction): boolean {
  return (
    stored.amount === desired.amount &&
    stored.date === desired.date &&
    stored.accountId === desired.accountId &&
    stored.transferToAccountId === desired.transferToAccountId &&
    stored.currency === desired.currency &&
    stored.type === desired.type
  );
}

/**
 * The reconcile DECISION (pure): given the currently-stored managed transfers and
 * the freshly-`desired` set, what to put and what to delete. Kept out of the store
 * so this — the subtle create-gate / delete-decoupling policy — is unit-testable
 * without a store:
 *  - CREATE a desired payoff only once its due date has arrived (`date <= asOf`);
 *    materialising a future-dated transfer early would wrongly reduce today's
 *    balance.
 *  - UPDATE an existing payoff when its statement amount changed (skip when it
 *    already matches → idempotent).
 *  - DELETE a stored payoff only when it's no longer DESIRED at all (auto-pay off,
 *    card archived, cycle fully credited, config narrowed) — NOT merely because
 *    this device's clock hasn't reached the due date. That asymmetry (create by the
 *    clock, delete by structural desire) is what stops multi-device ping-pong: a
 *    payoff a peer created is still in `desired` here (closedCycles doesn't filter
 *    by due), so it survives even when THIS device thinks it's not due yet.
 * The store maps `toPut` to `put` ops (stamping updatedAt/author) and `toDeleteIds`
 * to `delete` ops.
 */
export function planAutopayReconcile(
  existing: Transaction[],
  desired: Transaction[],
  asOf: string,
): { toPut: Transaction[]; toDeleteIds: string[] } {
  const existingById = new Map(existing.map((t) => [t.id, t]));
  const desiredIds = new Set(desired.map((t) => t.id));
  const toPut: Transaction[] = [];
  for (const d of desired) {
    const cur = existingById.get(d.id);
    if (cur) {
      if (!autopayTransferMatches(cur, d)) toPut.push(d); // amount/date changed
    } else if (d.date <= asOf) {
      toPut.push(d); // create once due
    }
    // else: closed but not yet due, and not already present → wait
  }
  const toDeleteIds = existing.filter((e) => !desiredIds.has(e.id)).map((e) => e.id);
  return { toPut, toDeleteIds };
}
