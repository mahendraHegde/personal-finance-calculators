// Small, reusable UI primitives + dependency-free SVG charts. Mobile-first
// Tailwind. Kept generic so every screen composes from the same vocabulary.

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import { ddmmyyyyToIso, formatDdmmyyyy, isoToDdmmyyyy } from "../../../lib/util/date";

export function Button({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
}) {
  const styles: Record<string, string> = {
    primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300",
    ghost: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    danger: "bg-red-50 text-red-700 hover:bg-red-100",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      // Exposes the variant so Modal can find the PRIMARY action button for
      // Enter-to-submit (and deliberately never the "danger"/"ghost" ones).
      data-variant={variant}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

/** A horizontal step indicator for multi-step flows (e.g. the CSV importer).
 *  Highlights the current step, marks completed ones, and stays readable on a phone
 *  (the connector lines collapse, labels stay). Purely presentational. */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-1 text-xs sm:gap-2" aria-label="Progress">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={i} className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2" aria-current={state === "active" ? "step" : undefined}>
            <span
              aria-hidden="true"
              className={
                "flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-semibold " +
                (state === "active"
                  ? "bg-blue-600 text-white"
                  : state === "done"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-slate-100 text-slate-400")
              }
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className={`truncate ${state === "todo" ? "text-slate-400" : "font-medium text-slate-600"}`}>
              {state === "done" && <span className="sr-only">Completed: </span>}
              {label}
            </span>
            {i < steps.length - 1 && <span className="mx-0.5 hidden h-px flex-1 bg-slate-200 sm:block" />}
          </li>
        );
      })}
    </ol>
  );
}

/** A card whose body is hidden until the user reveals it. The body is rendered
 *  only when `open`, so callers can gate expensive computation behind it (nothing
 *  runs until you open the section). `variant="eye"` reads as privacy/disclose
 *  (for sensitive figures); "chevron" as expand (for charts/tables). Controlled,
 *  so the parent owns `open` and can lazily compute the data it needs. */
export function RevealCard({
  title,
  subtitle,
  open,
  onToggle,
  variant = "chevron",
  children,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  variant?: "chevron" | "eye";
  children: ReactNode;
}) {
  const Icon = variant === "eye" ? (open ? EyeOff : Eye) : open ? ChevronUp : ChevronDown;
  return (
    <Card>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center justify-between gap-3 text-left">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-slate-400">
          <span className="hidden sm:inline">{open ? "Hide" : "Show"}</span>
          <Icon size={18} />
        </span>
      </button>
      {open && <div className="mt-4">{children}</div>}
    </Card>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold text-slate-800">{children}</h2>;
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600",
    green: "bg-green-100 text-green-700",
    amber: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone] ?? tones.slate}`}>
      {children}
    </span>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs font-normal text-slate-400">{hint}</span> : null}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  // A native <input type="date"> renders its display format from the BROWSER's
  // locale (Chrome ignores the element `lang`), so DD/MM can't be forced there.
  // Use an explicit DD/MM/YYYY text field instead — storage stays ISO yyyy-mm-dd.
  if (type === "date") return <DateInput value={value} onChange={onChange} placeholder={placeholder} />;
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      className={inputCls}
    />
  );
}

// --- Date field (DD/MM/YYYY display, ISO storage) --------------------------
/** DD/MM/YYYY date field. Emits an ISO `yyyy-mm-dd` string (or `""` when cleared)
 *  via `onChange` once the input parses to a real date; holds partial/invalid input
 *  locally so keystrokes aren't lost. Parents store/compare the ISO value exactly as
 *  before (this only changes what the user sees and types). */
function DateInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => isoToDdmmyyyy(value));
  const emitted = useRef(value);
  useEffect(() => {
    // Resync the display only when `value` changes from OUTSIDE (e.g. an edit form
    // opens) — not from our own emit, which would clobber the user mid-typing.
    if (value !== emitted.current) {
      setText(isoToDdmmyyyy(value));
      emitted.current = value;
    }
  }, [value]);
  const handle = (raw: string): void => {
    const formatted = formatDdmmyyyy(raw);
    setText(formatted);
    const iso = ddmmyyyyToIso(formatted);
    if (iso !== null && iso !== emitted.current) {
      emitted.current = iso;
      onChange(iso);
    }
  };
  const dirty = ddmmyyyyToIso(text) === null; // non-empty but not yet a real date
  const commit = (): void => {
    // A partial/invalid entry that never emitted (held) snaps the DISPLAY back to the
    // committed value (or "" if cleared) — so the field always shows exactly what a
    // Save would read, never a stray half-typed date.
    if (dirty) setText(isoToDdmmyyyy(emitted.current));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Enter with a held partial would let the Modal submit the last committed value
    // while the field shows the half-typed one. Reconcile the display and swallow the
    // Enter so a submit can only happen once the shown date is real (or cleared).
    if (e.key === "Enter" && dirty) {
      commit();
      e.stopPropagation();
    }
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder={placeholder ?? "dd/mm/yyyy"}
      value={text}
      onChange={(e: ChangeEvent<HTMLInputElement>) => handle(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      className={inputCls}
    />
  );
}

// Holds the RAW string so partial input ("1.", "-", "1.5") survives keystrokes —
// callers parse with Number(...) only at validation/save. inputMode gives a
// numeric keypad on mobile without the type="number" coercion quirks.
export function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      className={inputCls}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      disabled={disabled}
      className={`${inputCls}${disabled ? " cursor-not-allowed opacity-60" : ""}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Roomier dialog for multi-field forms (holdings, transactions). */
  wide?: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Autofocus the first field when the dialog opens, so you can start typing
  // immediately (standard form UX).
  useEffect(() => {
    const first = contentRef.current?.querySelector<HTMLElement>(
      "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    first?.focus();
  }, []);

  // Enter from a text input triggers the PRIMARY action (Add/Save) — but NOT
  // Delete (danger) or Cancel (ghost), so a stray Enter can never destroy data.
  // Ignored on textarea (newline), <select>/buttons (native behaviour), with a
  // modifier held, during IME composition, or when the primary button is disabled
  // (an invalid form) — matching exactly what a manual click would do.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.nativeEvent.isComposing) return;
    const t = e.target as HTMLElement;
    if (t.tagName !== "INPUT") return;
    const inputType = (t as HTMLInputElement).type;
    if (inputType === "checkbox" || inputType === "radio" || inputType === "button" || inputType === "submit") return;
    // This Enter belongs to THIS dialog's field. Dialogs can nest (the holding
    // editor / event form open INSIDE the holding-detail dialog, DOM-nested), so
    // stop it bubbling — otherwise a parent dialog's handler would also fire on the
    // same keystroke and double-trigger its primary action.
    e.stopPropagation();
    const primary = contentRef.current?.querySelector<HTMLButtonElement>(
      'button[data-variant="primary"]:not([disabled])',
    );
    if (primary) {
      e.preventDefault();
      primary.click();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={contentRef}
        className={`max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl ${wide ? "max-w-2xl" : "max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400 hover:text-slate-700">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  valueClass = "text-slate-800",
  title,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  /** Override the value colour (e.g. green/red for a gain). */
  valueClass?: string;
  /** Full-precision figure shown on hover when `value` is abbreviated. */
  title?: string;
}) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 truncate text-2xl font-semibold ${valueClass}`} title={title}>
        {value}
      </div>
      {sub && <div className="mt-1 text-sm text-slate-500">{sub}</div>}
    </Card>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  color: string;
}

/** Donut chart from segments (dependency-free SVG). */
export function Donut({
  segments,
  size = 160,
  format,
}: {
  segments: Segment[];
  size?: number;
  /** Formats a segment value for the hover label (e.g. money). */
  format?: (v: number) => string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const fmt = format ?? ((v: number) => String(v));
  const active = hi !== null ? segments[hi] : null;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`translate(${size / 2},${size / 2}) rotate(-90)`}>
          {total > 0 &&
            segments.map((seg, i) => {
              const frac = Math.max(0, seg.value) / total;
              const dash = frac * c;
              const el = (
                <circle
                  key={seg.label}
                  r={r}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={hi === i ? 20 : 16}
                  strokeDasharray={`${dash} ${c - dash}`}
                  strokeDashoffset={-offset}
                  opacity={hi === null || hi === i ? 1 : 0.35}
                  className="cursor-pointer transition-[stroke-width,opacity]"
                  onMouseEnter={() => setHi(i)}
                  onMouseLeave={() => setHi(null)}
                />
              );
              offset += dash;
              return el;
            })}
          {total === 0 && <circle r={r} fill="none" stroke="#e2e8f0" strokeWidth={16} />}
        </g>
      </svg>
      {/* Center read-out: the hovered slice, or the total at rest. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center leading-tight">
        {active ? (
          <>
            <span className="text-xs capitalize text-slate-500">{active.label}</span>
            <span className="text-sm font-semibold text-slate-800">{fmt(Math.max(0, active.value))}</span>
            <span className="text-xs text-slate-400">
              {total > 0 ? Math.round((Math.max(0, active.value) / total) * 100) : 0}%
            </span>
          </>
        ) : (
          <>
            <span className="text-[10px] uppercase tracking-wide text-slate-400">Total</span>
            <span className="text-sm font-semibold text-slate-700">{fmt(total)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Grouped income/expense bars per month (dependency-free SVG). */
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthAbbr = (ym: string): string => MONTH_ABBR[Number(ym.slice(5, 7)) - 1] ?? ym;
const monthLong = (ym: string): string => `${monthAbbr(ym)} ${ym.slice(0, 4)}`;

export function BarTrend({
  data,
  width = 360,
  height = 140,
  format,
}: {
  data: Array<{ month: string; income: number; expense: number }>;
  width?: number;
  height?: number;
  /** Formats income/expense for the hover read-out (e.g. money). */
  format?: (v: number) => string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  if (data.length === 0) return <EmptyState>No activity yet.</EmptyState>;
  const recent = data.slice(-12);
  const max = Math.max(1, ...recent.flatMap((d) => [d.income, d.expense]));
  const fmt = format ?? ((v: number) => String(v));
  const groupW = width / recent.length;
  const barW = Math.min(groupW / 3, 18);
  const active = hi !== null ? recent[hi] : null;
  return (
    <div>
      {/* Legend at rest; the hovered month's figures when hovering. */}
      <div className="mb-2 flex min-h-[1.25rem] flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex gap-3 text-slate-500">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-600" /> Income
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-600" /> Expense
          </span>
        </div>
        {active && (
          <span className="text-slate-600">
            <span className="font-medium">{monthLong(active.month)}</span> ·{" "}
            <span className="text-green-600">+{fmt(active.income)}</span> /{" "}
            <span className="text-red-600">−{fmt(active.expense)}</span>
          </span>
        )}
      </div>
      <svg width="100%" viewBox={`0 0 ${width} ${height + 30}`} preserveAspectRatio="none">
        {recent.map((d, i) => {
          const cx = i * groupW + groupW / 2;
          const ih = (d.income / max) * height;
          const eh = (d.expense / max) * height;
          // Label the year under the first bar of each year (data may skip months
          // and cross year boundaries), so "Mar" is never ambiguous on the axis.
          const showYear = i === 0 || d.month.slice(0, 4) !== recent[i - 1].month.slice(0, 4);
          return (
            <g key={d.month} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}>
              {/* full-height hit area so hovering anywhere in the column works */}
              <rect x={i * groupW} y={0} width={groupW} height={height} fill="transparent" />
              <rect x={cx - barW - 1} y={height - ih} width={barW} height={ih} fill="#16a34a" rx={2}
                opacity={hi === null || hi === i ? 1 : 0.4} />
              <rect x={cx + 1} y={height - eh} width={barW} height={eh} fill="#dc2626" rx={2}
                opacity={hi === null || hi === i ? 1 : 0.4} />
              <text x={cx} y={height + 14} textAnchor="middle"
                className={hi === i ? "fill-slate-700 text-[9px] font-medium" : "fill-slate-400 text-[9px]"}>
                {monthAbbr(d.month)}
              </text>
              {showYear && (
                <text x={cx} y={height + 25} textAnchor="middle" className="fill-slate-300 text-[8px]">
                  {d.month.slice(0, 4)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
