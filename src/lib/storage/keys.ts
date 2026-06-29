// Key extraction, ordering, and range tests shared by storage adapters.
// Ordering follows the IndexedDB key sort: numbers < strings, arrays compared
// element-wise — so the in-memory adapter behaves like the IndexedDB one.

import type { IndexKey, QueryRange } from "./types";

/** Pull an index key out of a record by keyPath. Returns undefined if any
 *  component is missing (matches IndexedDB: such records are not indexed). */
export function extractKey(
  record: Record<string, unknown>,
  keyPath: string | string[],
): IndexKey | undefined {
  if (Array.isArray(keyPath)) {
    const parts: Array<string | number> = [];
    for (const k of keyPath) {
      const v = record[k];
      if (v === undefined || v === null) return undefined;
      parts.push(v as string | number);
    }
    return parts;
  }
  const v = record[keyPath];
  return v === undefined || v === null ? undefined : (v as IndexKey);
}

function typeRank(v: string | number): number {
  return typeof v === "number" ? 0 : 1; // number sorts before string
}

export function compareKeys(a: IndexKey, b: IndexKey): number {
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    const ax = aArr ? a : [a as string | number];
    const bx = bArr ? b : [b as string | number];
    const n = Math.min(ax.length, bx.length);
    for (let i = 0; i < n; i++) {
      const c = compareScalar(ax[i], bx[i]);
      if (c !== 0) return c;
    }
    return ax.length - bx.length;
  }
  return compareScalar(a as string | number, b as string | number);
}

function compareScalar(a: string | number, b: string | number): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Does `key` satisfy the range's bounds? (index selection happens upstream) */
export function inRange(key: IndexKey, range: QueryRange): boolean {
  if (range.equals !== undefined) return compareKeys(key, range.equals) === 0;
  if (range.lower !== undefined) {
    const c = compareKeys(key, range.lower);
    if (c < 0 || (c === 0 && range.lowerOpen)) return false;
  }
  if (range.upper !== undefined) {
    const c = compareKeys(key, range.upper);
    if (c > 0 || (c === 0 && range.upperOpen)) return false;
  }
  return true;
}
