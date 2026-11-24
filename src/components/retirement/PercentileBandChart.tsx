import { useEffect, useRef, useState } from "react";
import type { MonteCarloPercentilePoint } from "../../types/retirement";
import { HELP } from "./help";
import { InfoTip } from "./ui";

interface PercentileBandChartProps {
  percentiles: MonteCarloPercentilePoint[];
  // Expected (deterministic) path, drawn as a dashed line for comparison.
  deterministic: { age: number; value: number }[];
  retirementAge: number;
  unitLabel: string;
}

export const PercentileBandChart = ({
  percentiles,
  deterministic,
  retirementAge,
  unitLabel,
}: PercentileBandChartProps) => {
  // Draw at the container's real pixel width so text stays ~11px on phones
  // instead of shrinking with a fixed viewBox.
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(480);
  const isEmpty = percentiles.length === 0;
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setMeasuredWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isEmpty]);
  if (isEmpty) return null;

  const width = Math.max(260, measuredWidth);
  const height = Math.round(Math.min(260, Math.max(190, width * 0.45)));
  const padding = { top: 12, right: 12, bottom: 26, left: 60 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const minAge = percentiles[0].age;
  const maxAge = percentiles[percentiles.length - 1].age;
  const ageRange = Math.max(1, maxAge - minAge);

  // The P90 tail grows explosively over long horizons and used to squash
  // the median and P10 into the x-axis.  Scale to the P75 band (or the
  // expected path, whichever is higher) and clip the P90 band at the top.
  const maxP90 = Math.max(1, ...percentiles.map((p) => p.p90));
  const maxP75 = Math.max(1, ...percentiles.map((p) => p.p75));
  const maxDet = Math.max(0, ...deterministic.map((d) => d.value));
  const maxValue = Math.min(maxP90, Math.max(maxP75 * 1.25, maxDet * 1.1));
  const clipped = maxP90 > maxValue * 1.001;

  const xFor = (age: number) =>
    padding.left + ((age - minAge) / ageRange) * innerW;
  const yFor = (v: number) =>
    padding.top +
    innerH -
    (Math.min(maxValue, Math.max(0, v)) / maxValue) * innerH;

  const buildArea = (
    upper: (p: MonteCarloPercentilePoint) => number,
    lower: (p: MonteCarloPercentilePoint) => number,
  ) => {
    const top = percentiles
      .map((p) => `${xFor(p.age)},${yFor(upper(p))}`)
      .join(" ");
    const bottom = percentiles
      .slice()
      .reverse()
      .map((p) => `${xFor(p.age)},${yFor(lower(p))}`)
      .join(" ");
    return `M ${top} L ${bottom} Z`;
  };

  const medianPath = percentiles
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(p.age)} ${yFor(p.p50)}`)
    .join(" ");
  const detPath = deterministic
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xFor(d.age)} ${yFor(d.value)}`)
    .join(" ");

  const formatTick = (v: number) => {
    if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e8 ? 0 : 1)}Cr`;
    if (v >= 1e5) return `₹${(v / 1e5).toFixed(0)}L`;
    if (v >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
    return `₹${v.toFixed(0)}`;
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxValue);
  const midAge = Math.round((minAge + maxAge) / 2);
  const xTicks = Array.from(new Set([minAge, midAge, maxAge]));

  return (
    <div className="bg-white rounded p-2 border border-pink-200">
      <div className="mb-1 flex items-center text-xs font-medium text-gray-600">
        Savings by age ({unitLabel})
        <InfoTip text={HELP.chart} label="Savings by age chart" />
      </div>
      <div ref={containerRef} className="w-full">
        <svg
          width="100%"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Monte Carlo corpus percentile bands by age"
        >
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={yFor(t)}
                y2={yFor(t)}
                stroke="#f1f5f9"
              />
              <text
                x={padding.left - 4}
                y={yFor(t) + 3}
                fontSize="11"
                textAnchor="end"
                fill="#64748b"
              >
                {formatTick(t)}
              </text>
            </g>
          ))}

          <path
            d={buildArea(
              (p) => p.p90,
              (p) => p.p10,
            )}
            fill="#fbcfe8"
            opacity="0.6"
          />
          <path
            d={buildArea(
              (p) => p.p75,
              (p) => p.p25,
            )}
            fill="#f9a8d4"
            opacity="0.7"
          />
          <path d={medianPath} fill="none" stroke="#be185d" strokeWidth="1.5" />
          {deterministic.length > 1 && (
            <path
              d={detPath}
              fill="none"
              stroke="#2563eb"
              strokeWidth="1.25"
              strokeDasharray="4,3"
            />
          )}

          {retirementAge >= minAge && retirementAge <= maxAge && (
            <g>
              <line
                x1={xFor(retirementAge)}
                x2={xFor(retirementAge)}
                y1={padding.top}
                y2={height - padding.bottom}
                stroke="#7c3aed"
                strokeDasharray="3,3"
              />
              <text
                x={xFor(retirementAge) + 3}
                y={padding.top + 10}
                fontSize="11"
                fill="#7c3aed"
              >
                retire @ {retirementAge}
              </text>
            </g>
          )}

          {xTicks.map((age) => (
            <text
              key={age}
              x={xFor(age)}
              y={height - 6}
              fontSize="11"
              // Anchor the end ticks inward so "age 90" isn't cut off.
              textAnchor={
                age === minAge ? "start" : age === maxAge ? "end" : "middle"
              }
              fill="#64748b"
            >
              age {age}
            </text>
          ))}
        </svg>
      </div>
      <div className="flex gap-3 text-xs text-gray-600 mt-1 ml-2 sm:ml-12 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 inline-block bg-pink-200 rounded-sm" />
          P10 to P90
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 inline-block bg-pink-300 rounded-sm" />
          P25 to P75
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 inline-block bg-pink-700" /> Median
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 inline-block border-t border-dashed border-blue-600" />{" "}
          Expected path
        </span>
        {clipped && (
          <span className="text-gray-400">P90 band clipped at the top</span>
        )}
      </div>
    </div>
  );
};
