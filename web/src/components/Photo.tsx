import type { SilKind } from "../silhouette";
import type { Photo as PhotoT } from "../types";
import { Silhouette } from "./ui";

/**
 * Planespotters terms: the browser calls their API directly; the thumbnail links to the photo page using the
 * `link` URL unchanged; the photographer credit is visible text next to the image; URLs are used unchanged.
 */
export function HeroPhoto({ photo, loading, kind, alt }: { photo: PhotoT | null; loading: boolean; kind: SilKind; alt: string }) {
  const img = photo?.thumbnail_large ?? photo?.thumbnail;
  return (
    <>
      <div className="hero-media">
        {img && photo ? (
          <a href={photo.link} target="_blank" rel="noopener" aria-label={`Photo of ${alt} on Planespotters.net`}>
            <img src={img.src} width={img.size.width} height={img.size.height} alt={`${alt}, photographed by ${photo.photographer}`} decoding="async" />
          </a>
        ) : loading ? (
          <div className="sk" style={{ position: "absolute", inset: 0, borderRadius: 0 }} aria-hidden="true" />
        ) : (
          <Silhouette kind={kind} className="sil" title={`Illustration of the aircraft type (no photo available)`} />
        )}
      </div>
      <p className="credit">
        {photo ? (
          <>
            Photo ©{" "}
            <a href={photo.link} target="_blank" rel="noopener">
              {photo.photographer}
            </a>{" "}
            via Planespotters.net
          </>
        ) : loading ? (
          " "
        ) : (
          "No photo of this exact aircraft yet. Illustration shows the general type."
        )}
      </p>
    </>
  );
}
