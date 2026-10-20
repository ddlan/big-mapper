// Smooth reveal heatmap for a daily puzzle: Gaussian-weighted blend of the grid
// scores, faded out where there's no data (water) and feathered at the circle edge.

import { type Puzzle, pctOfBest } from "./daily";

const SIZE = 360; // px per side; ~6 m/px for a 1 km radius
const SIGMA_M = 90; // blend width, ~0.6 of the 150 m grid spacing
/** Muted worst -> best ramp; easier on the eyes than traffic-light colors. */
const RAMP: [number, [number, number, number]][] = [
  [0, [201, 123, 107]], // muted brick
  [0.4, [233, 196, 143]], // sand
  [0.7, [185, 211, 154]], // sage
  [0.88, [111, 179, 138]],
  [1, [47, 143, 106]], // deep green
];
export const HEATMAP_GRADIENT_CSS = `linear-gradient(90deg, ${RAMP.map(
  ([t, c]) => `rgb(${c.join(",")}) ${Math.round(t * 100)}%`,
).join(", ")})`;

function rampColor(t: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    const [t0, c0] = RAMP[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * f) as [number, number, number];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface HeatmapImage {
  url: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

export function renderHeatmap(p: Puzzle): HeatmapImage {
  const [clon, clat] = p.center;
  const mPerDegLat = 111_195;
  const mPerDegLon = mPerDegLat * Math.cos((clat * Math.PI) / 180);
  const half = p.radiusM * 1.04;
  const mPerPx = (2 * half) / SIZE;

  // Grid points in local meters (x east, y north) with their % of best.
  const pts = p.grid.map(([lon, lat, km2]) => ({
    x: (lon - clon) * mPerDegLon,
    y: (lat - clat) * mPerDegLat,
    pct: pctOfBest(km2, p),
  }));
  const lo = Math.min(...pts.map((q) => q.pct));
  const span = Math.max(1, 100 - lo);
  // Weight sum for a pixel surrounded by grid points on all sides.
  const fullCoverage = (2 * Math.PI * SIGMA_M * SIGMA_M) / (150 * 150);
  const inv2s2 = 1 / (2 * SIGMA_M * SIGMA_M);
  const cutoff2 = (3 * SIGMA_M) ** 2;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let py = 0; py < SIZE; py++) {
    const y = half - (py + 0.5) * mPerPx;
    for (let px = 0; px < SIZE; px++) {
      const x = -half + (px + 0.5) * mPerPx;
      const r = Math.hypot(x, y);
      const edge = 1 - smoothstep(p.radiusM * 0.96, p.radiusM * 1.02, r);
      if (edge <= 0) continue;
      let wSum = 0, vSum = 0;
      for (const q of pts) {
        const d2 = (q.x - x) ** 2 + (q.y - y) ** 2;
        if (d2 > cutoff2) continue;
        const w = Math.exp(-d2 * inv2s2);
        wSum += w;
        vSum += w * q.pct;
      }
      if (wSum === 0) continue;
      const alpha = edge * smoothstep(0.12, 0.55, wSum / fullCoverage);
      if (alpha <= 0) continue;
      const [cr, cg, cb] = rampColor((vSum / wSum - lo) / span);
      const o = (py * SIZE + px) * 4;
      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  const dLon = half / mPerDegLon, dLat = half / mPerDegLat;
  return {
    url: canvas.toDataURL("image/png"),
    coordinates: [
      [clon - dLon, clat + dLat], [clon + dLon, clat + dLat],
      [clon + dLon, clat - dLat], [clon - dLon, clat - dLat],
    ],
  };
}
