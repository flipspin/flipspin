import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { artColorFor, initials } from "./cardArt";
import { subscribeCoverRetry } from "./coverRetry";

const RETRY_DELAYS = [2_000, 8_000, 30_000];

/** Let callers own cover geometry and borders. Missing or failed art uses initials
 * so lazy cover requests do not leave broken images. */
interface CoverTileProps {
  src: string | null | undefined;
  /** What the initials are cut from when there is no picture. */
  label: string;
  className?: string;
  style?: CSSProperties;
  /** Initials size; a CSS length. */
  fontSize?: string;
  children?: ReactNode;
}

function markIfReady(img: HTMLImageElement | null) {
  if (img?.complete && img.naturalWidth > 0) {
    img.dataset.instant = "";
    img.dataset.loaded = "";
  }
}

export default function CoverTile({ src, label, className = "", style, fontSize = "clamp(20px, 3vw, 40px)", children }: CoverTileProps) {
  const [broken, setBroken] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);
  const failed = useRef(false);
  const retry = useCallback(() => {
    if (!failed.current) return;
    failed.current = false;
    setAttempt(value => value + 1);
    setBroken(false);
  }, []);
  useEffect(() => {
    retries.current = 0;
    failed.current = false;
    setBroken(false);
    if (!src) return;
    return subscribeCoverRetry(() => {
      if (!failed.current) return;
      retries.current = 0;
      retry();
    });
  }, [src, retry]);
  useEffect(() => {
    if (!src || !broken) return;
    // A missing cover is normal: exhaust this budget, then wait for a real
    // reconnect or focus. Cleanup also stops retries for virtualized tiles.
    const delay = RETRY_DELAYS[retries.current];
    const timer = delay === undefined ? undefined : window.setTimeout(() => {
      retries.current++;
      retry();
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [src, broken, retry]);
  const showArt = Boolean(src) && !broken;
  return (
    <span
      className={`relative grid place-items-center overflow-hidden ${className}`}
      style={{ background: showArt ? "var(--panel-2)" : artColorFor(label), ...style }}
      // Decorative unless a caller puts a control inside (Home's play button).
      aria-hidden={children ? undefined : true}
    >
      {showArt ? (
        // Fades in when it arrives (scrolling no longer blinks covers in);
        // one already decoded at mount; a cached cover; shows at once.
        // Marked on the element, not in state: a long list loads hundreds.
        <img
          key={`${src}-${attempt}`}
          ref={markIfReady}
          src={src ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(e) => { e.currentTarget.dataset.loaded = ""; }}
          onError={() => { failed.current = true; setBroken(true); }}
          className="absolute inset-0 h-full w-full object-cover opacity-0 data-[loaded]:opacity-100 transition-opacity duration-(--dur-fast) ease-(--ease-out) data-[instant]:transition-none"
        />
      ) : (
        <span
          className="select-none font-extrabold leading-none text-black/80"
          style={{ fontFamily: "var(--font-display)", fontSize }}
        >
          {initials(label)}
        </span>
      )}
      {children}
    </span>
  );
}

/**
 * A playlist's cover: the first four albums tiled 2×2 when it spans that many,
 * the first album's cover alone when it has fewer, initials when it has none.
 * `covers` are already URLs; `label` names the playlist.
 */
export function CoverMosaic({ covers, label, className = "", style, fontSize }: { covers: string[]; label: string; className?: string; style?: CSSProperties; fontSize?: string }) {
  if (covers.length >= 4) {
    return (
      <span className={`grid grid-cols-2 grid-rows-2 overflow-hidden ${className}`} style={style} aria-hidden>
        {covers.slice(0, 4).map((src, i) => (
          <CoverTile key={`${src}-${i}`} src={src} label={label} className="h-full w-full" fontSize="clamp(12px, 1.6vw, 20px)" />
        ))}
      </span>
    );
  }
  return <CoverTile src={covers[0] ?? null} label={label} className={className} style={style} fontSize={fontSize} />;
}
