// Small SVG charts for the audience map: a city map, a market quadrant, the comp orbit and a
// lift strip. Pure rendering from the run's own numbers; no Qloo calls and no extra data
// except the static city table (lib/geo/cities.ts) and two schematic country outlines.

import type { Comp, Overlap, RankedMarket } from "@/lib/types";
import { CITIES } from "@/lib/geo/cities";
import { liftPoints } from "@/lib/labels";
import { cx } from "./ui";

// Schematic outlines (lon, lat), coarse on purpose: they only give the dots a place to sit.
const US: [number, number][] = [
  [-124.7, 48.4], [-123, 49], [-95.2, 49], [-94.8, 49.4], [-89.6, 48], [-84.8, 46.5], [-82.5, 45.3], [-82.4, 43], [-79, 43.3], [-76.5, 44.2],
  [-75, 45], [-71.5, 45], [-70, 46.7], [-67.8, 47.1], [-67, 44.8], [-70.2, 43.6], [-70.6, 41.6], [-74, 40.6], [-75.5, 38.5], [-76, 37],
  [-75.5, 35.2], [-77.9, 33.9], [-81, 32], [-81.4, 30.3], [-80, 26.8], [-80.4, 25.2], [-81.8, 26], [-82.8, 27.9], [-83.6, 29.9], [-85.3, 29.7],
  [-88, 30.4], [-89.6, 30.2], [-89.4, 29], [-91.5, 29.5], [-94, 29.7], [-95, 29.2], [-97.2, 27.6], [-97.4, 25.9], [-99.1, 26.4], [-100.3, 28.3],
  [-101.4, 29.8], [-103.1, 29], [-104.5, 29.8], [-106.5, 31.8], [-108.2, 31.3], [-111.1, 31.3], [-114.8, 32.5], [-117.1, 32.5], [-118.5, 34],
  [-120.6, 34.6], [-122.4, 37.2], [-123.7, 38.9], [-124.2, 41], [-124.5, 42.8], [-124, 46.3],
];
const GB: [number, number][] = [
  [-5.7, 50.05], [-4.2, 50.4], [-3.4, 50.6], [-1.5, 50.7], [0.3, 50.8], [1.4, 51.2], [0.9, 51.8], [1.75, 52.6], [0.3, 53.1], [0.1, 53.6],
  [-0.6, 54.5], [-1.6, 55.6], [-2.1, 56], [-2.6, 56.3], [-1.8, 57.6], [-3.4, 58.6], [-5, 58.6], [-5.4, 57.5], [-5.7, 56.5], [-5.6, 55.4],
  [-4.9, 54.8], [-3.3, 54.8], [-3.6, 54.4], [-3, 53.4], [-4.6, 53.3], [-4.4, 52.8], [-4.1, 52.2], [-5.2, 51.8], [-3.1, 51.4], [-4.2, 51.2],
];

type Frame = { lon: [number, number]; lat: [number, number]; w: number; h: number; outline: [number, number][] };
const FRAMES: Record<string, Frame> = {
  US: { lon: [-125.5, -66], lat: [24, 50], w: 400, h: 220, outline: US },
  GB: { lon: [-6.5, 2.2], lat: [49.8, 59], w: 120, h: 220, outline: GB },
};

const proj = (f: Frame) => (lon: number, lat: number) => [((lon - f.lon[0]) / (f.lon[1] - f.lon[0])) * f.w, ((f.lat[1] - lat) / (f.lat[1] - f.lat[0])) * f.h] as const;

/** Dot size: market score (concentration plus over-index), 0..~1.5. */
const radius = (m: RankedMarket | undefined) => (m ? 3 + 11 * Math.sqrt(Math.max(0, Math.min(1.5, m.score)) / 1.5) : 0);

/**
 * City dots sized by market score and coloured by over-index against the reference audience.
 * Dots are keyed by city, so a comp swap animates each dot to its new size; the previous run's
 * size stays as a faint ring.
 */
export function MarketMap({ markets, previous, countries, top = 5 }: { markets: RankedMarket[]; previous?: RankedMarket[]; countries: string[]; top?: number }) {
  const shown = countries.filter((c) => FRAMES[c] && markets.some((m) => m.country === c));
  if (!shown.length) return null;
  const rank = new Map(markets.map((m, i) => [m.name, i]));
  return (
    <div className="flex items-end gap-4">
      {shown.map((country) => {
        const f = FRAMES[country];
        const p = proj(f);
        const path = f.outline.map(([lon, lat], i) => `${i ? "L" : "M"}${p(lon, lat).map((n) => n.toFixed(1)).join(",")}`).join("") + "Z";
        const cities = CITIES.filter((c) => c.country === country);
        return (
          <svg key={country} viewBox={`-8 -8 ${f.w + 16} ${f.h + 16}`} className="h-auto min-w-0" style={{ flex: `${f.w + 16} 1 0px`, maxWidth: f.w + 16 }} role="img" aria-label={`Fan concentration by city, ${country}`}>
            <path d={path} className="fill-surface-2 stroke-line" strokeWidth={1} />
            {cities.map((c) => {
              const m = markets.find((x) => x.name === c.name);
              const was = previous?.find((x) => x.name === c.name);
              const [x, y] = p(c.lon, c.lat);
              const r = radius(m);
              const over = m?.overIndex;
              const isTop = m && (rank.get(m.name) ?? 99) < top;
              return (
                <g key={c.name} transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}>
                  <title>
                    {c.name}
                    {m ? `: score ${m.score.toFixed(2)}${m.concentration !== undefined ? `, concentration ${Math.round(m.concentration * 100)}th pct` : ""}${over !== undefined ? `, ${liftPoints(over)} vs typical` : ""}${m.broad ? " (over-indexes for every comp: check before spending)" : ""}` : ": no signal"}
                  </title>
                  {was && <circle r={radius(was)} className="fill-none stroke-muted" strokeDasharray="2 2" strokeWidth={0.8} opacity={0.6} />}
                  <circle
                    r={1}
                    className={cx(over === undefined ? "fill-accent" : over > 0 ? "fill-accent" : "fill-muted", m?.broad && "stroke-warn")}
                    strokeWidth={m?.broad ? 0.15 : 0}
                    strokeDasharray={m?.broad ? "0.3 0.2" : undefined}
                    opacity={m ? (over !== undefined && over <= 0 ? 0.35 : 0.75) : 0}
                    style={{ transform: `scale(${r || 0.001})`, transition: "transform 700ms ease, opacity 700ms ease" }}
                  />
                  {isTop && (
                    <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" y={-r - 3} textAnchor="middle" className="fill-ink text-[10px] font-medium" style={{ transition: "transform 700ms ease" }}>
                      {c.name}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        );
      })}
    </div>
  );
}

/**
 * Over-index × scale: where these fans over-index (x) against metro size (y, log). Top right is
 * where to scale; top left, small and specific, is where to test cheaply.
 */
export function MarketQuadrant({ markets }: { markets: RankedMarket[] }) {
  const pts = markets.filter((m) => m.overIndex !== undefined && m.population);
  if (pts.length < 4) return null;
  const W = 340;
  const H = 220;
  const pad = 26;
  const xs = pts.map((m) => m.overIndex!);
  const xMax = Math.max(0.2, ...xs.map(Math.abs));
  const lp = (n: number) => Math.log10(n);
  const yMin = lp(Math.min(...pts.map((m) => m.population!)));
  const yMax = lp(Math.max(...pts.map((m) => m.population!)));
  const X = (v: number) => pad + ((v + xMax) / (2 * xMax)) * (W - 2 * pad);
  const Y = (pop: number) => H - pad - ((lp(pop) - yMin) / (yMax - yMin || 1)) * (H - 2 * pad);
  const yMid = (H - 2 * pad) / 2 + pad;
  const sorted = [...pts].sort((a, b) => b.score - a.score);
  const labelled = new Set(sorted.slice(0, 8).map((m) => m.name));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-md" role="img" aria-label="Markets by over-index and size">
      <line x1={X(0)} x2={X(0)} y1={pad / 2} y2={H - pad} className="stroke-line" />
      <line x1={pad} x2={W - pad} y1={yMid} y2={yMid} className="stroke-line" />
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={W - pad} y={pad / 2 + 4} textAnchor="end" className="fill-evidence text-[10px] font-semibold">
        Scale (expand here)
      </text>
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={W - pad} y={H - pad - 4} textAnchor="end" className="fill-evidence text-[10px] font-semibold">
        Efficient (test here)
      </text>
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={pad} y={pad / 2 + 4} className="fill-muted text-[10px]">
        Big but generic
      </text>
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={pad} y={H - pad - 4} className="fill-muted text-[10px]">
        Skip
      </text>
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={W / 2} y={H - 6} textAnchor="middle" className="fill-muted text-[10px]">
        ← under-indexes · over-index vs a typical audience · over-indexes →
      </text>
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={8} y={H / 2} textAnchor="middle" transform={`rotate(-90 8 ${H / 2})`} className="fill-muted text-[10px]">
        metro size (log)
      </text>
      {pts.map((m) => (
        <g key={m.name} transform={`translate(${X(m.overIndex!).toFixed(1)},${Y(m.population!).toFixed(1)})`} style={{ transition: "transform 700ms ease" }}>
          <title>{`${m.name}: ${liftPoints(m.overIndex!)} vs typical, ~${m.population}M people${m.broad ? " (over-indexes for every comp)" : ""}`}</title>
          <circle r={3.5} className={cx(m.overIndex! > 0 ? "fill-accent" : "fill-muted", m.broad && "stroke-warn")} strokeWidth={m.broad ? 1.2 : 0} opacity={0.8} />
          {labelled.has(m.name) && (
            <text
              paintOrder="stroke"
              stroke="var(--surface)"
              strokeWidth={3}
              strokeLinejoin="round"
              x={X(m.overIndex!) > W * 0.72 ? -5 : 5}
              y={3}
              textAnchor={X(m.overIndex!) > W * 0.72 ? "end" : "start"}
              className="fill-ink text-[9px]"
            >
              {m.name}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

const VERDICT_TONE = { one: "stroke-evidence", adjacent: "stroke-accent", different: "stroke-muted" } as const;

/** Comps as nodes; edge thickness is mutual lift. Control titles sit faint at the edge. */
export function CompOrbit({ comps, overlaps }: { comps: Comp[]; overlaps: Overlap[] }) {
  if (comps.length < 2 || !overlaps.some((o) => o.mutualLift !== undefined)) return null;
  const W = 300;
  const H = 210;
  const cx0 = W / 2;
  const cy0 = H / 2 + 4;
  const R = comps.length === 2 ? 80 : 68;
  const pos = new Map(comps.map((c, i) => [c.entityId, [cx0 + R * Math.cos(-Math.PI / 2 + (2 * Math.PI * i) / comps.length + (comps.length === 2 ? Math.PI / 2 : 0)), cy0 + R * Math.sin(-Math.PI / 2 + (2 * Math.PI * i) / comps.length + (comps.length === 2 ? Math.PI / 2 : 0))] as const]));
  const controls = [...new Set(overlaps.flatMap((o) => o.controls?.map((c) => c.name) ?? []))].slice(0, 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-xs" role="img" aria-label="How strongly each pair of comps shares an audience">
      {controls.map((name, i) => (
        <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" key={name} x={i ? W - 4 : 4} y={12} textAnchor={i ? "end" : "start"} className="fill-muted text-[9px]" opacity={0.7}>
          control: {name}
        </text>
      ))}
      {overlaps.map((o) => {
        const a = pos.get(o.a);
        const b = pos.get(o.b);
        if (!a || !b || o.mutualLift === undefined) return null;
        const w = 1 + Math.max(0, o.mutualLift) * 40;
        return (
          <g key={o.a + o.b}>
            <title>{`mutual lift ${liftPoints(o.mutualLift)} points: ${o.verdict === "one" ? "one audience" : o.verdict === "adjacent" ? "adjacent audiences" : "different audiences"}`}</title>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={VERDICT_TONE[o.verdict ?? "different"]} strokeWidth={w} strokeLinecap="round" opacity={o.verdict === "different" ? 0.5 : 0.8} strokeDasharray={o.verdict === "different" ? "4 4" : undefined} />
            <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={(a[0] + b[0]) / 2} y={(a[1] + b[1]) / 2 - w / 2 - 3} textAnchor="middle" className="fill-muted text-[9px]">
              {liftPoints(o.mutualLift)}
            </text>
          </g>
        );
      })}
      {comps.map((c) => {
        const [x, y] = pos.get(c.entityId)!;
        return (
          <g key={c.entityId} transform={`translate(${x},${y})`}>
            <circle r={7} className="fill-surface stroke-ink" strokeWidth={1.5} />
            <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" y={y > cy0 ? 20 : -12} textAnchor="middle" className="fill-ink text-[10px] font-semibold">
              {c.name.length > 22 ? `${c.name.slice(0, 21)}…` : c.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Two rows of lift dots on one scale: the model alone vs Crossover. */
export function LiftStrip({ rows }: { rows: { label: string; lifts: number[] }[] }) {
  const all = rows.flatMap((r) => r.lifts);
  if (!all.length) return null;
  const W = 360;
  const rowH = 30;
  const pad = 96;
  const max = Math.max(0.1, ...all.map(Math.abs));
  const X = (v: number) => pad + ((v + max) / (2 * max)) * (W - pad - 10);
  const H = rows.length * rowH + 22;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-lg" role="img" aria-label="Partner lift, model alone vs Crossover">
      <line x1={X(0)} x2={X(0)} y1={4} y2={H - 18} className="stroke-line" />
      {rows.map((r, i) => {
        const y = 16 + i * rowH;
        const sorted = [...r.lifts].sort((a, b) => a - b);
        const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
        return (
          <g key={r.label}>
            <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={0} y={y + 3} className="fill-ink text-[10px] font-medium">
              {r.label}
            </text>
            {r.lifts.map((v, j) => (
              <circle key={j} cx={X(v)} cy={y + ((j % 3) - 1) * 4} r={3} className={v > 0 ? "fill-evidence" : "fill-warn"} opacity={0.7} />
            ))}
            {med !== undefined && <line x1={X(med)} x2={X(med)} y1={y - 9} y2={y + 9} className="stroke-ink" strokeWidth={1.5} />}
          </g>
        );
      })}
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={X(-max)} y={H - 4} className="fill-muted text-[9px]">
        {liftPoints(-max)}
      </text>
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={X(0)} y={H - 4} textAnchor="middle" className="fill-muted text-[9px]">
        0 = typical audience
      </text>
      <text paintOrder="stroke" stroke="var(--surface)" strokeWidth={3} strokeLinejoin="round" x={X(max)} y={H - 4} textAnchor="end" className="fill-muted text-[9px]">
        {liftPoints(max)}
      </text>
    </svg>
  );
}
