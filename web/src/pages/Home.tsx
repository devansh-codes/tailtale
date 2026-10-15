import { type FormEvent, useState } from "react";
import { api, FetchError } from "../api";
import { Card, Skeleton } from "../components/ui";
import { fmtInt, pluralModel } from "../format";
import { navigate, useTitle } from "../router";
import { typeLabel } from "../typeNames";
import { useLoad } from "../useLoad";

const EXAMPLES = ["N557AS", "AA100", "A5CF41"];

export function SearchBox({ initial = "", autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FetchError | null>(null);

  async function go(query: string) {
    const v = query.trim();
    if (!v) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.resolve(v);
      navigate(`/p/${r.hex}`, { resolved: r, q: v });
    } catch (e) {
      setErr(e instanceof FetchError ? e : new FetchError(0, "unknown", "Something went wrong. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void go(q);
  };

  return (
    <>
      <label htmlFor="q" className="search-label">
        Flight number, tail number, or hex
      </label>
      <form className="search" role="search" onSubmit={submit}>
        <input
          id="q"
          name="q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="DL1234 or N557AS"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus={autoFocus}
          enterKeyHint="search"
          aria-describedby={err ? "q-err" : undefined}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Looking…" : "Look up"}
        </button>
      </form>
      <div className="examples">
        <span className="muted small">Try</span>
        {EXAMPLES.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => {
              setQ(x);
              void go(x);
            }}
          >
            {x}
          </button>
        ))}
      </div>
      {err && (
        <div className="error-box" id="q-err" role="alert">
          <strong>{err.code === "not_found" ? "We couldn't find that one right now." : err.code === "bad_query" ? "That doesn't look like a flight or tail number." : "Lookup failed."}</strong>
          <p className="sub">{err.message}</p>
          {err.hint && <p style={{ marginTop: 8 }}>{err.hint}</p>}
        </div>
      )}
    </>
  );
}

export function Home() {
  useTitle("TailTale: the life story of the plane you're on");
  const sib = useLoad(() => api.allSiblings(), []);
  const top = sib.data ? Object.entries(sib.data.types).sort((a, b) => b[1] - a[1]).slice(0, 6) : [];
  const total = sib.data ? Object.values(sib.data.types).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <section className="home-hero">
        <h1>Tell me the life story of the plane I'm sitting in.</h1>
        <p className="sub" style={{ marginTop: 10 }}>
          Type the flight number from your boarding pass, or the tail number painted on the plane. You'll get its age, its owner,
          where it's been this month, and how many of its siblings are flying right now.
        </p>
        <SearchBox autoFocus={false} />
      </section>

      <Card title="Planes flying right now" busy={sib.loading}>
        {sib.loading ? (
          <div className="stats three">
            {Array.from({ length: 6 }, (_, i) => (
              <div className="stat" key={i}>
                <Skeleton h={24} w="50%" />
                <Skeleton h={12} w="80%" style={{ marginTop: 8 }} />
              </div>
            ))}
          </div>
        ) : top.length ? (
          <>
            <p className="sub" style={{ marginBottom: 12 }}>
              <strong className="num">{fmtInt(total)}</strong> airliners of the {Object.keys(sib.data!.types).length} most common types are in the air worldwide, as seen by
              volunteer receivers in the last 10 minutes.
            </p>
            <div className="stats three">
              {top.map(([t, n]) => (
                <div className="stat" key={t}>
                  <span className="value num">{fmtInt(n)}</span>
                  <span className="label">{pluralModel(typeLabel(t), n)}</span>
                  <span className="src">Source: ADSB.lol live data</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">Live counts are warming up. Check back in a few minutes.</p>
        )}
      </Card>

      <Card title="How it works">
        <ol className="sub" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Your flight number is matched to the aircraft broadcasting it right now (including regional partners like SkyWest).</li>
          <li>Its transponder code unlocks the FAA registry record: build year, serial, engines, registered owner.</li>
          <li>A nightly pipeline turns volunteer ADS-B data into a 30-day flight history for every US-registered aircraft.</li>
        </ol>
      </Card>
    </>
  );
}
