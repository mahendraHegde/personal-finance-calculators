import { Info, Trash2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { inputCls, labelCls, num, optNum, placeTooltip } from "./format";
import { HELP } from "./help";

// ⓘ button with a plain-language explanation.  Opens on hover, keyboard
// focus or tap; closes on Escape, blur, mouse leave or a tap elsewhere.  The
// bubble is fixed-positioned and kept entirely inside the viewport: it is
// measured after rendering and opens below its button if it fits, else
// above, else is clamped to the screen (scrolling inside if it is taller
// than the screen).  It follows its button when the page scrolls (focusing
// an off-screen ⓘ scrolls it into view).
const TIP_MARGIN = 8;
const TIP_GAP = 4;
const TIP_MAX_WIDTH = 288;

interface TipAnchor {
  left: number;
  width: number;
  top: number; // button top
  bottom: number; // button bottom
  maxHeight: number; // visible viewport height minus margins
}

export function InfoTip({ text, label }: { text: ReactNode; label?: string }) {
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const [top, setTop] = useState<number | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const id = useId();
  const show = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const width = Math.min(TIP_MAX_WIDTH, vw - 2 * TIP_MARGIN);
    const left = Math.min(Math.max(TIP_MARGIN, r.left), vw - width - TIP_MARGIN);
    // innerHeight is the visible viewport (excludes a mobile toolbar, unlike
    // CSS 100vh).
    setAnchor({ left, width, top: r.top, bottom: r.bottom, maxHeight: window.innerHeight - 2 * TIP_MARGIN });
    setTop(null); // re-measure before it is shown
  };
  const hide = () => {
    setAnchor(null);
    setTop(null);
  };
  const open = anchor !== null;

  // Place vertically once the bubble's real height is known (runs before
  // paint, so it never flashes in the wrong place).
  useLayoutEffect(() => {
    if (!anchor || top !== null || !bubble.current) return;
    setTop(
      placeTooltip(anchor.top, anchor.bottom, bubble.current.offsetHeight, window.innerHeight, TIP_MARGIN, TIP_GAP),
    );
  }, [anchor, top]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) hide();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", show, true);
    window.addEventListener("resize", show);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", show, true);
      window.removeEventListener("resize", show);
    };
  }, [open]);
  return (
    <span
      ref={wrap}
      className="relative inline-flex align-middle"
      onMouseEnter={show}
      onMouseLeave={hide}
      // Close when focus leaves the ⓘ AND its bubble.  Tabbing into a bubble
      // taller than the screen lets arrow keys scroll it.
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) hide();
      }}
    >
      <button
        type="button"
        aria-label={label ? `What is "${label}"?` : "More information"}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={show}
        onFocus={show}
        className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <Info size={13} aria-hidden />
      </button>
      {anchor && (
        <span
          ref={bubble}
          role="tooltip"
          id={id}
          style={{
            left: anchor.left,
            top: top ?? anchor.bottom + TIP_GAP,
            width: anchor.width,
            maxHeight: anchor.maxHeight,
            visibility: top === null ? "hidden" : "visible",
          }}
          className="fixed z-50 overflow-y-auto rounded-md bg-gray-900 px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-white shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// Label + optional ⓘ + control.  The ⓘ sits outside the <label> so tapping
// it doesn't focus the input.
export function Field({
  label,
  help,
  className,
  labelClassName = labelCls,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  className?: string;
  labelClassName?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={className}>
      <div className="mb-1 flex min-h-4 items-center">
        <label htmlFor={id} className={labelClassName}>
          {label}
        </label>
        {help && <InfoTip text={help} label={typeof label === "string" ? label : undefined} />}
      </div>
      {children(id)}
    </div>
  );
}

export function NumberField({
  label,
  help,
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
  className,
  labelClassName,
}: {
  label: ReactNode;
  help?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <Field label={label} help={help} className={className} labelClassName={labelClassName}>
      {(id) => (
        <input
          id={id}
          type="number"
          step={step}
          min={min}
          max={max}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(num(e.target.value))}
          className={inputCls}
        />
      )}
    </Field>
  );
}

// Optional number: empty stays empty (undefined), e.g. "use the default".
export function OptionalNumberField({
  label,
  help,
  value,
  onChange,
  step,
  min,
  placeholder,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: string;
  min?: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Field label={label} help={help} className={className}>
      {(id) => (
        <input
          id={id}
          type="number"
          step={step}
          min={min}
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(e) => onChange(optNum(e.target.value))}
          className={`${inputCls} placeholder:text-gray-400`}
        />
      )}
    </Field>
  );
}

export function TextField({
  label,
  help,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Field label={label} help={help} className={className}>
      {(id) => (
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        />
      )}
    </Field>
  );
}

// Coloured card with a heading, an ⓘ and optional actions.
export function Section({
  title,
  help,
  helpLabel,
  tone,
  actions,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  // Name read out for the ⓘ when the title isn't plain text.
  helpLabel?: string;
  tone: string; // e.g. "bg-green-50 text-green-800"
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [bg, fg] = tone.split(" ");
  return (
    <div className={`${bg} rounded-lg p-4 sm:p-6`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className={`flex items-center text-xl font-semibold ${fg}`}>
          {title}
          {help && <InfoTip text={help} label={helpLabel ?? (typeof title === "string" ? title : undefined)} />}
        </h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function AddButton({
  onClick,
  tone,
  children,
}: {
  onClick: () => void;
  tone: string; // e.g. "bg-green-600 hover:bg-green-700"
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 py-1 text-sm text-white ${tone}`}
    >
      {children}
    </button>
  );
}

export function RemoveButton({
  onClick,
  disabled,
  name,
}: {
  onClick: () => void;
  disabled?: boolean;
  name: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full justify-center rounded p-2 text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:hover:bg-transparent"
      aria-label={`Remove ${name || "item"}`}
    >
      <Trash2 size={16} />
    </button>
  );
}

// One investment bucket row.  On phones the remove button sits next to the
// name and the numbers wrap to a second line; from `sm` up it's one line.
export function BucketRow({
  nameLabel,
  name,
  namePlaceholder,
  onName,
  middle,
  rate,
  onRate,
  rateHelp = HELP.returnAfterTax,
  volatilityHelp = HELP.volatility,
  volatility,
  onVolatility,
  defaultVolatility,
  onRemove,
  removeDisabled,
  children,
}: {
  nameLabel: string;
  name: string;
  namePlaceholder: string;
  onName: (v: string) => void;
  middle: ReactNode;
  rate: number;
  onRate: (v: number) => void;
  rateHelp?: string;
  volatilityHelp?: string;
  volatility: number | undefined;
  onVolatility: (v: number | undefined) => void;
  defaultVolatility: number;
  onRemove: () => void;
  removeDisabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 rounded-md border bg-white p-4">
      <div className="grid grid-cols-12 items-end gap-3">
        <TextField
          className="order-1 col-span-10 sm:order-none sm:col-span-4"
          label={nameLabel}
          value={name}
          onChange={onName}
          placeholder={namePlaceholder}
        />
        <div className="order-3 col-span-6 sm:order-none sm:col-span-3">{middle}</div>
        <NumberField
          className="order-4 col-span-3 sm:order-none sm:col-span-2"
          label="Return %"
          help={rateHelp}
          step="0.1"
          value={rate}
          onChange={onRate}
        />
        <OptionalNumberField
          className="order-5 col-span-3 sm:order-none sm:col-span-2"
          label="Volatility %"
          help={volatilityHelp}
          step="0.5"
          min={0}
          placeholder={String(defaultVolatility)}
          value={volatility}
          onChange={onVolatility}
        />
        <div className="order-2 col-span-2 sm:order-none sm:col-span-1">
          <RemoveButton onClick={onRemove} disabled={removeDisabled} name={name} />
        </div>
      </div>
      {children}
    </div>
  );
}

export function Metric({
  label,
  help,
  valueClass = "",
  children,
}: {
  label: string;
  help?: string;
  valueClass?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="flex items-center text-gray-700">
        {label}
        {help && <InfoTip text={help} label={label.replace(/:$/, "")} />}
      </span>
      <span className={`text-right font-semibold ${valueClass}`}>{children}</span>
    </div>
  );
}
