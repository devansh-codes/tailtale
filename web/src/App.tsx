import { useEffect, useState } from "react";
import { About, NotFoundPage } from "./pages/About";
import { Home } from "./pages/Home";
import { Plane } from "./pages/Plane";
import { Quality } from "./pages/Quality";
import { Link, usePath } from "./router";

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
    <button type="button" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
      {dark ? "☀︎" : "☾"}
    </button>
  );
}

export default function App() {
  const path = usePath();
  const m = /^\/p\/([0-9a-fA-F]{6})\/?$/.exec(path);
  let page;
  if (path === "/" || path === "") page = <Home />;
  else if (m) page = <Plane key={m[1].toUpperCase()} hex={m[1].toUpperCase()} />;
  else if (path === "/about") page = <About />;
  else if (path === "/quality") page = <Quality />;
  else page = <NotFoundPage />;
  const cur = (p: string) => (path === p ? "page" : undefined);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="logo" aria-label="TailTale home">
            <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
              <path d="M14 38 L40 26 Q50 22 52 26 Q53 29 46 32 L20 44 Z" fill="#fcfcfb" />
              <path d="M18 36 L12 22 L18 22 L27 32 Z" fill="#7fb4ef" />
              <path d="M33 31 L26 46 L32 46 L42 30 Z" fill="#cde2fb" />
            </svg>
            TailTale
          </Link>
          <nav className="topnav" aria-label="Main">
            <Link href="/about" aria-current={cur("/about")}>
              About
            </Link>
            <Link href="/quality" aria-current={cur("/quality")}>
              Data quality
            </Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main id="main">{page}</main>
      <footer className="footer">
        <div className="footer-inner">
          <p>
            <strong>For curiosity only.</strong> Not for navigation, safety, or operational decisions. Data comes from volunteers and public records and can be
            wrong or delayed.
          </p>
          <p>
            Data: ADSB.lol (ODbL), FAA registry, Planespotters.net, adsbdb, OurAirports, OpenFlights (ODbL), OpenFreeMap / OpenStreetMap.{" "}
            <Link href="/about">Attribution</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
