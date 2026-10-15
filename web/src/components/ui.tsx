import type { ReactNode } from "react";
import { silhouette, type SilKind } from "../silhouette";

export function Silhouette({ kind, className, title }: { kind: SilKind; className?: string; title?: string }) {
  const parts = silhouette(kind);
  return (
    <svg viewBox="0 0 240 100" className={className} role="img" aria-label={title ?? `Illustration of a ${kind} aircraft`}>
      {parts.map((p, i) => (
        <path key={i} d={p.d} fill={p.ink ? "currentColor" : "var(--surface)"} opacity={p.ink ? 1 : 0.85} />
      ))}
    </svg>
  );
}

/** A number with its label and visible source line ("every number labeled with its source"). */
export function Stat({ label, value, source, wide, text }: { label: string; value: ReactNode; source: string; wide?: boolean; text?: boolean }) {
  return (
    <div className={`stat${wide ? " wide" : ""}`}>
      <span className="label">{label}</span>
      <span className={`value${text ? " text" : ""}`}>{value ?? "—"}</span>
      <span className="src">Source: {source}</span>
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="sk" style={{ height: h, width: w, ...style }} aria-hidden="true" />;
}

export function Card({ title, children, id, busy }: { title: string; children: ReactNode; id?: string; busy?: boolean }) {
  return (
    <section className="card" aria-labelledby={id ? `${id}-h` : undefined} aria-busy={busy || undefined}>
      <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
      {children}
    </section>
  );
}

export function SkeletonStats({ n = 4 }: { n?: number }) {
  return (
    <div className="stats">
      {Array.from({ length: n }, (_, i) => (
        <div className="stat" key={i}>
          <Skeleton h={12} w="60%" />
          <Skeleton h={24} w="80%" style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}
