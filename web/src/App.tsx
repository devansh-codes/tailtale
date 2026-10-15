import { useEffect, useState } from "react";
import { About, NotFoundPage } from "./pages/About";
import { Home } from "./pages/Home";
import { Plane } from "./pages/Plane";
import { Quality } from "./pages/Quality";
import { Link, navigate, usePath } from "./router";

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M16 54 L28 8 L40 8 L50 54 Z" fill="currentColor" />
      <path d="M10 54 H54" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string | undefined>(() => document.documentElement.dataset.theme);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem("tt-theme", theme);
      else localStorage.removeItem("tt-theme");
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
  }, [theme]);
  const dark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  return (
    <button type="button" className="iconbtn" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
      {dark ? "☀︎" : "☾"}
    </button>
  );
}

function lookUp() {
  if (location.pathname !== "/") navigate("/");
  requestAnimationFrame(() => document.getElementById("q")?.focus());
}

export default function App() {
  const path = usePath();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  const m = /^\/p\/([0-9a-fA-F]{6})\/?$/.exec(path);
  let page;
  if (path === "/" || path === "") page = <Home />;
  else if (m) page = <Plane key={m[1].toUpperCase()} hex={m[1].toUpperCase()} />;
  else if (path === "/about") page = <About />;
  else if (path === "/quality") page = <Quality />;
  else page = <NotFoundPage />;
  const cur = (p: string) => (path === p || (p === "/" && !!m) ? "page" : undefined);
  return (
    <div className="shell">
      <div className="banner">
        Free and open source. Built on volunteer ADS-B receivers and public FAA records.{" "}
        <Link href="/about">How it works ›</Link>
      </div>
      <div className="navwrap">
        <header className="nav">
          <Link href="/" className="logo" aria-label="TailTale home">
            <Mark />
            TailTale
          </Link>
          <nav className="pills" aria-label="Sections">
            <Link href="/" aria-current={cur("/")}>
              Planes
            </Link>
            <Link href="/quality" aria-current={cur("/quality")}>
              Data quality
            </Link>
          </nav>
          <div className="navlinks">
            <Link href="/about" className="textlink" aria-current={cur("/about")}>
              About
            </Link>
            <ThemeToggle />
            <button type="button" className="btn small" onClick={lookUp} aria-label="Look up a plane">
              Look up<span className="wide-only">&nbsp;a plane</span>
            </button>
            <button type="button" className="iconbtn menu-btn" aria-expanded={menu} aria-controls="menu" aria-label="Menu" onClick={() => setMenu(!menu)}>
              ☰
            </button>
          </div>
        </header>
        {menu && (
          <nav className="menu" id="menu" aria-label="Main">
            <Link href="/">Planes</Link>
            <Link href="/quality">Data quality</Link>
            <Link href="/about">About and data</Link>
          </nav>
        )}
      </div>
      <main id="main">{page}</main>
      <footer className="footer">
        <div className="footer-inner">
          <p className="wordmark">TailTale</p>
          <p>
            <strong>For curiosity only.</strong> Not for navigation, safety, or operational decisions. Data comes from volunteers and public records and can be
            wrong or delayed.
          </p>
          <p>
            Data: ADSB.lol (ODbL), <a href="https://adsb.fi">adsb.fi</a>, FAA registry, Planespotters.net, adsbdb, OurAirports, OpenFlights (ODbL), OpenFreeMap /
            OpenStreetMap. <Link href="/about">Attribution</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
