// Formatting and input-parsing helpers shared by the retirement UI.

export const formatCurrency = (amount: number): string => {
  if (!Number.isFinite(amount)) return "n/a";
  const sign = amount < 0 ? "-" : "";
  const a = Math.abs(amount);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e9 ? 0 : 2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`;
  return `${sign}₹${Math.round(a).toLocaleString("en-IN")}`;
};

export const formatPct = (fraction: number, digits = 1): string =>
  Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : "n/a";

// Empty input → 0 for required numbers, → undefined for optional ones.
export const num = (v: string): number => (v === "" ? 0 : Number(v));
export const optNum = (v: string): number | undefined =>
  v === "" ? undefined : Number(v);

export const patchById = <T extends { id: number }>(
  list: T[],
  id: number,
  patch: Partial<T>,
): T[] => list.map((x) => (x.id === id ? { ...x, ...patch } : x));

export const inputCls = "w-full p-2 text-sm border border-gray-300 rounded bg-white";
export const labelCls = "text-xs text-gray-600";

// Success rate at or above which the plan is shown as on track (green).
export const GOOD_SUCCESS_RATE = 0.85;

// Tooltip vertical placement: below the button if the bubble fits, else
// above if it fits, else clamped into the screen (the bubble's height is
// capped to the screen, and it scrolls inside).  All values in px.
export const placeTooltip = (
  buttonTop: number,
  buttonBottom: number,
  bubbleHeight: number,
  viewportHeight: number,
  margin = 8,
  gap = 4,
): number => {
  const below = buttonBottom + gap;
  const above = buttonTop - gap - bubbleHeight;
  if (below + bubbleHeight <= viewportHeight - margin) return below;
  if (above >= margin) return above;
  return Math.min(Math.max(margin, below), Math.max(margin, viewportHeight - bubbleHeight - margin));
};
