import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { MapPoint } from "./MapView";

const MapView = lazy(() => import("./MapView"));

/** Downloads MapLibre only when the map scrolls into view (slow airplane Wi-Fi). */
export function LazyMap(props: { points: MapPoint[]; line?: [number, number][]; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (!("IntersectionObserver" in window)) return setShow(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setShow(true), { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref}>
      {show ? (
        <Suspense fallback={<div className="map sk" aria-hidden="true" />}>
          <MapView {...props} />
        </Suspense>
      ) : (
        <div className="map" aria-hidden="true" />
      )}
    </div>
  );
}
