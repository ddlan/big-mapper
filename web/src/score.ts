// Connectivity score: reachable area under fixed, standard settings, so every
// spot is judged the same way and a precomputed reference distribution applies.

import type { RouteParams } from "./router";

export const SCORE_SETTINGS = {
  periodId: "rush",
  maxMinutes: 45,
  walkSpeedKmh: 5,
  transferPenaltyMin: 5,
  initialWaitMin: 0,
} as const;

/** Full router params for scoring a spot. `period` is resolved from meta by the caller. */
export function scoreParams(lon: number, lat: number, period: number, modeCount: number): RouteParams {
  const { periodId: _, ...rest } = SCORE_SETTINGS;
  return { lon, lat, period, modes: Array(modeCount).fill(true), ...rest };
}

export interface ScoreDistribution {
  generated: string;
  settings: typeof SCORE_SETTINGS;
  samples: number;
  /** Reachable km² of each sampled origin, ascending. */
  sorted: number[];
}

/** Share of sampled spots (0-100) with a strictly lower score. */
export function percentile(dist: ScoreDistribution, km2: number): number {
  const a = dist.sorted;
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < km2) lo = mid + 1;
    else hi = mid;
  }
  return (100 * lo) / a.length;
}
