import { useId, useState } from "react";

/**
 * Small single-series charts, drawn as SVG. Thin marks, 4px rounded bar tops on a baseline, 2px lines,
 * hover/tap tooltips, a recessive axis, and a table view for screen readers and anyone who prefers numbers.
 */

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  tip: string;
}

export function BarChart({ data, height = 120, caption, color = "var(--series-1)", tableHead }: {
  data: BarDatum[];
  height?: number;
  caption?: [string, string];
  color?: string;
  tableHead: [string, string];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = height;
  const pad = 2;
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = W / data.length;
  const barW = Math.max(2, bw - 2); // 2px surface gap between adjacent bars
  const id = useId();
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 1}`} role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>{`${tableHead[1]} by ${tableHead[0].toLowerCase()}`}</title>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - (H - pad) * f} y2={H - (H - pad) * f} stroke="var(--grid)" strokeWidth={1} />
        ))}
        {data.map((d, i) => {
          const h = d.value > 0 ? Math.max(3, ((H - pad) * d.value) / max) : 0;
          const x = i * bw + (bw - barW) / 2;
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.key}>
              {h > 0 && (
                <path
                  d={`M ${x} ${H} L ${x} ${H - h + r} Q ${x} ${H - h} ${x + r} ${H - h} L ${x + barW - r} ${H - h} Q ${x + barW} ${H - h} ${x + barW} ${H - h + r} L ${x + barW} ${H} Z`}
                  fill={color}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {/* hit target larger than the mark */}
              <rect
                x={i * bw}
                y={0}
                width={bw}
                height={H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onClick={() => setHover(hover === i ? null : i)}
              />
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--axis)" strokeWidth={1} />
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: `${((hover + 0.5) / data.length) * 100}%`, top: `${(1 - data[hover].value / max) * 100}%` }} role="status">
          {data[hover].tip}
        </div>
      )}
      {caption && (
        <div className="chart-caption">
          <span>{caption[0]}</span>
          <span>{caption[1]}</span>
        </div>
      )}
      <details className="table-view">
        <summary>Show as table</summary>
        <table className="data">
          <thead>
            <tr>
              <th>{tableHead[0]}</th>
              <th className="r">{tableHead[1]}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.key}>
                <td>{d.label}</td>
                <td className="r num">{d.value.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export interface LinePoint {
  x: number;
  y: number;
}

export interface Series {
  name: string;
  color: string;
  points: LinePoint[];
}

/** Line chart with a crosshair tooltip. One shared y-scale only (no dual axes). */
export function LineChart({ series, height = 140, fmtX, fmtY, yMax, caption, tableHead }: {
  series: Series[];
  height?: number;
  fmtX: (x: number) => string;
  fmtY: (y: number) => string;
  yMax?: number;
  caption?: [string, string];
  tableHead: string;
}) {
  const [hx, setHx] = useState<number | null>(null);
  const W = 600;
  const H = height;
  const all = series.flatMap((s) => s.points);
  const id = useId();
  if (new Set(all.map((p) => p.x)).size < 2) return <p className="muted small">Not enough data yet; this fills in as days accumulate.</p>;
  const x0 = Math.min(...all.map((p) => p.x));
  const x1 = Math.max(...all.map((p) => p.x));
  const top = yMax ?? Math.max(1, ...all.map((p) => p.y)) * 1.1;
  const sx = (x: number) => (x1 === x0 ? W / 2 : ((x - x0) / (x1 - x0)) * W);
  const sy = (y: number) => H - (y / top) * (H - 4);
  const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
  const nearest = (px: number) => xs.reduce((b, x) => (Math.abs(sx(x) - px) < Math.abs(sx(b) - px) ? x : b), xs[0]);
  return (
    <div className="chart">
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H + 1}`}
        role="img"
        aria-labelledby={`${id}-t`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHx(nearest(((e.clientX - r.left) / r.width) * W));
        }}
        onMouseLeave={() => setHx(null)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHx(nearest(((e.clientX - r.left) / r.width) * W));
        }}
      >
        <title id={`${id}-t`}>{tableHead}</title>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={sy(top * f)} y2={sy(top * f)} stroke="var(--grid)" strokeWidth={1} />
        ))}
        <line x1={0} x2={W} y1={H} y2={H} stroke="var(--axis)" strokeWidth={1} />
        {series.map((s) => (
          <path
            key={s.name}
            d={s.points.map((p, i) => `${i ? "L" : "M"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hx !== null && (
          <>
            <line x1={sx(hx)} x2={sx(hx)} y1={0} y2={H} stroke="var(--axis)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {series.map((s) => {
              const p = s.points.find((q) => q.x === hx);
              return p ? <circle key={s.name} cx={sx(p.x)} cy={sy(p.y)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null;
            })}
          </>
        )}
      </svg>
      {hx !== null && (
        <div className="tip" style={{ left: `${Math.min(85, Math.max(15, (sx(hx) / W) * 100))}%`, top: 0 }} role="status">
          <strong>{fmtX(hx)}</strong>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === hx);
            return p ? <div key={s.name}>{series.length > 1 ? `${s.name}: ` : ""}{fmtY(p.y)}</div> : null;
          })}
        </div>
      )}
      {caption && (
        <div className="chart-caption">
          <span>{caption[0]}</span>
          <span>{caption[1]}</span>
        </div>
      )}
      <details className="table-view">
        <summary>Show as table</summary>
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              {series.map((s) => (
                <th className="r" key={s.name}>
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {xs.map((x) => (
              <tr key={x}>
                <td>{fmtX(x)}</td>
                {series.map((s) => {
                  const p = s.points.find((q) => q.x === x);
                  return (
                    <td className="r num" key={s.name}>
                      {p ? fmtY(p.y) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
