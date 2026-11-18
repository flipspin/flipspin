/** Sample the cover for small accents; the blurred artwork supplies the backdrop.
 * Fall back when an image or CORS failure prevents sampling so lyrics remain readable. */
import { useEffect, useState } from "react";

export interface ArtworkPalette {
  accent: string;
  base: string;
}

const FALLBACK: ArtworkPalette = { accent: "var(--coral, #EF7E55)", base: "#16161c" };
const SIZE = 24;
const cache = new Map<string, ArtworkPalette>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

/**
 * The dominant *vivid* hue: pixels are binned by hue and weighted by how
 * saturated they are, so a red sleeve with a white border answers red. The
 * accent is that hue at a lightness that reads on the dark scrim.
 */
export function paletteFromPixels(data: Uint8ClampedArray): ArtworkPalette {
  const bins = new Array<number>(12).fill(0);
  const sums = Array.from({ length: 12 }, () => ({ h: 0, s: 0, w: 0 }));
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    rSum += r;
    gSum += g;
    bSum += b;
    count += 1;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.25 || l < 0.12 || l > 0.9) continue;
    const bin = Math.min(11, Math.floor(h * 12));
    const w = s * (1 - Math.abs(l - 0.5));
    bins[bin] += w;
    sums[bin].h += h * w;
    sums[bin].s += s * w;
    sums[bin].w += w;
  }
  if (count === 0) return FALLBACK;
  const base = `rgb(${Math.round((rSum / count) * 255 * 0.22)}, ${Math.round((gSum / count) * 255 * 0.22)}, ${Math.round((bSum / count) * 255 * 0.22)})`;
  const top = bins.indexOf(Math.max(...bins));
  if (bins[top] <= 0) return { accent: FALLBACK.accent, base };
  const hue = Math.round((sums[top].h / sums[top].w) * 360);
  const sat = Math.round(Math.min(0.9, Math.max(0.55, sums[top].s / sums[top].w)) * 100);
  return { accent: `hsl(${hue} ${sat}% 68%)`, base };
}

export function sampleArtwork(url: string): Promise<ArtworkPalette> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        const palette = paletteFromPixels(ctx.getImageData(0, 0, SIZE, SIZE).data);
        cache.set(url, palette);
        resolve(palette);
      } catch {
        resolve(FALLBACK);
      }
    };
    img.onerror = () => resolve(FALLBACK);
    img.src = url;
  });
}

export function useArtworkPalette(url: string | null | undefined): ArtworkPalette {
  const [palette, setPalette] = useState<ArtworkPalette>(() => (url && cache.get(url)) || FALLBACK);
  useEffect(() => {
    if (!url) {
      setPalette(FALLBACK);
      return undefined;
    }
    let live = true;
    void sampleArtwork(url).then((p) => {
      if (live) setPalette(p);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return palette;
}
