// Travel-time bands -> colors, and painting an isochrone grid into pixels.

import type { Isochrone } from "./router";

const PALETTE = ["#1a9850", "#66bd63", "#d9ef8b", "#fee08b", "#fdae61", "#f46d43", "#d73027", "#8e2a8a"];

/** Band width in minutes for a given time limit, so there are ~6-12 bands. */
export function bandMinutes(maxMinutes: number): number {
  if (maxMinutes <= 45) return 5;
  if (maxMinutes <= 90) return 10;
  if (maxMinutes <= 180) return 15;
  return 30;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** RGB for each band, sampled evenly across the palette. */
export function bandColors(count: number): [number, number, number][] {
  const stops = PALETTE.map(hexToRgb);
  return Array.from({ length: count }, (_, i) => {
    const f = count === 1 ? 0 : (i / (count - 1)) * (stops.length - 1);
    const a = Math.floor(f);
    const b = Math.min(stops.length - 1, a + 1);
    const t = f - a;
    return stops[a].map((c, k) => Math.round(c + (stops[b][k] - c) * t)) as [number, number, number];
  });
}

export function paint(iso: Isochrone, bandSec: number, colors: [number, number, number][]): ImageData {
  const img = new ImageData(iso.width, iso.height);
  const px = img.data;
  const { times } = iso;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!(t <= iso.maxSeconds)) continue;
    const band = Math.min(colors.length - 1, Math.floor(t / bandSec));
    const c = colors[band];
    const o = i * 4;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
    px[o + 3] = 255;
  }
  return img;
}
