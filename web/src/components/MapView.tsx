import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef } from "react";

// MapLibre derives its worker URL from import.meta.url, which bundling rewrites; hand it the bundled worker.
maplibregl.setWorkerUrl(workerUrl);

export interface MapPoint {
  lat: number;
  lon: number;
  label: string;
  kind: "plane" | "airport";
}

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Loaded lazily (own chunk) so MapLibre never blocks first paint. Tiles: OpenFreeMap (free, keyless). */
export default function MapView({ points, line, label }: { points: MapPoint[]; line?: [number, number][]; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !points.length) return;
    const dark = isDark();
    const map = new maplibregl.Map({
      container: el.current,
      style: `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`,
      // The OpenFreeMap style carries its own attribution ("OpenFreeMap © OpenMapTiles Data from OpenStreetMap").
      attributionControl: { compact: true },
      interactive: true,
      cooperativeGestures: true,
      center: [points[0].lon, points[0].lat],
      zoom: 4,
    });
    const accent = dark ? "#e2c4fb" : "#034f46";
    const ink = dark ? "#ffffeb" : "#1a1a1a";
    map.on("load", () => {
      // Start the compact attribution collapsed behind its (i) button so it doesn't cover a small map.
      map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      if (line && line.length > 1) {
        map.addSource("line", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } } });
        map.addLayer({ id: "line", type: "line", source: "line", paint: { "line-color": accent, "line-width": 2, "line-dasharray": [2, 2] } });
      }
      map.addSource("pts", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: points.map((p) => ({ type: "Feature", properties: { label: p.label, kind: p.kind }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })),
        },
      });
      map.addLayer({
        id: "pts",
        type: "circle",
        source: "pts",
        paint: {
          "circle-radius": ["match", ["get", "kind"], "plane", 7, 5],
          "circle-color": ["match", ["get", "kind"], "plane", accent, ink],
          "circle-stroke-color": dark ? "#12241f" : "#ffffeb",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "labels",
        type: "symbol",
        source: "pts",
        layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Regular"] },
        paint: { "text-color": ink, "text-halo-color": dark ? "#12241f" : "#ffffeb", "text-halo-width": 1.5 },
      });
      const all: [number, number][] = [...points.map((p) => [p.lon, p.lat] as [number, number]), ...(line ?? [])];
      if (all.length > 1) {
        const b = all.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
        map.fitBounds(b, { padding: 36, maxZoom: 8, duration: 0 });
      } else {
        map.setZoom(6);
      }
    });
    return () => map.remove();
  }, [points, line]);
  return <div ref={el} className="map" role="img" aria-label={label} />;
}
