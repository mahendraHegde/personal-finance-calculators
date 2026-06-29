// Small, reusable UI primitives + dependency-free SVG charts. Mobile-first
// Tailwind. Kept generic so every screen composes from the same vocabulary.

import type { ChangeEvent, ReactNode } from "react";

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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
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

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-800">{value}</div>
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
export function Donut({ segments, size = 160 }: { segments: Segment[]; size?: number }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <g transform={`translate(${size / 2},${size / 2}) rotate(-90)`}>
        {total > 0 &&
          segments.map((seg) => {
            const frac = Math.max(0, seg.value) / total;
            const dash = frac * c;
            const el = (
              <circle
                key={seg.label}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth={16}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return el;
          })}
        {total === 0 && <circle r={r} fill="none" stroke="#e2e8f0" strokeWidth={16} />}
      </g>
    </svg>
  );
}

/** Grouped income/expense bars per month (dependency-free SVG). */
export function BarTrend({
  data,
  width = 320,
  height = 140,
}: {
  data: Array<{ month: string; income: number; expense: number }>;
  width?: number;
  height?: number;
}) {
  if (data.length === 0) return <EmptyState>No activity yet.</EmptyState>;
  const recent = data.slice(-6);
  const max = Math.max(1, ...recent.flatMap((d) => [d.income, d.expense]));
  const groupW = width / recent.length;
  const barW = groupW / 3;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height + 20}`}>
      {recent.map((d, i) => {
        const x = i * groupW + groupW / 2;
        const ih = (d.income / max) * height;
        const eh = (d.expense / max) * height;
        return (
          <g key={d.month}>
            <rect x={x - barW} y={height - ih} width={barW - 2} height={ih} fill="#16a34a" rx={2} />
            <rect x={x + 2} y={height - eh} width={barW - 2} height={eh} fill="#dc2626" rx={2} />
            <text x={x} y={height + 14} textAnchor="middle" className="fill-slate-400 text-[9px]">
              {d.month.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
