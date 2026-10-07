// Daily game: pick the best-connected spot inside a small area, under a daily
// twist to the standard score settings. Shared by the app and the puzzle generator.

import type { Meta } from "./graph";
import type { RouteParams } from "./router";
import { SCORE_SETTINGS, scoreParams } from "./score";

export const GUESSES_PER_DAY = 3;
/** Day #1 of the game, local date. */
export const EPOCH = "2026-09-30";

export interface Twist {
  id: string;
  emoji: string;
  label: string;
  description: string;
  /** Adjusts the standard score params; mode groups are looked up by name in meta.modeGroups. */
  apply(p: RouteParams, meta: Meta): RouteParams;
}

const withModes = (p: RouteParams, meta: Meta, keep: (name: string) => boolean): RouteParams => ({
  ...p,
  modes: meta.modeGroups.map(keep),
});
const periodIdx = (meta: Meta, id: string) => meta.periods.findIndex((x) => x.id === id);

export const TWISTS: Twist[] = [
  {
    id: "rush", emoji: "🚦", label: "Rush hour", description: "A regular weekday commute.",
    apply: (p) => p,
  },
  {
    id: "rail-strike", emoji: "🪧", label: "Rail strike", description: "No BART, Caltrain or other heavy rail today.",
    apply: (p, m) => withModes(p, m, (g) => g !== "rail"),
  },
  {
    id: "bus-only", emoji: "🚌", label: "Bus only", description: "Buses only: no trains, streetcars or ferries.",
    apply: (p, m) => withModes(p, m, (g) => g === "bus"),
  },
  {
    id: "no-bus", emoji: "🚆", label: "Rails & ferries", description: "Everything except buses.",
    apply: (p, m) => withModes(p, m, (g) => g !== "bus"),
  },
  {
    id: "late-night", emoji: "🦉", label: "Late night", description: "Owl service only (midnight to 5am).",
    apply: (p, m) => ({ ...p, period: periodIdx(m, "night") }),
  },
  {
    id: "saturday", emoji: "🛍️", label: "Saturday", description: "Weekend daytime service.",
    apply: (p, m) => ({ ...p, period: periodIdx(m, "weekend") }),
  },
  {
    id: "quick-trip", emoji: "⏱️", label: "Quick trip", description: "You only have 20 minutes.",
    apply: (p) => ({ ...p, maxMinutes: 20 }),
  },
  {
    id: "long-haul", emoji: "🧭", label: "Long haul", description: "You have 75 minutes.",
    apply: (p) => ({ ...p, maxMinutes: 75 }),
  },
  {
    id: "one-seat", emoji: "💺", label: "One-seat ride", description: "No transfers: one vehicle, then walk.",
    // A transfer costing the whole time budget can never help.
    apply: (p) => ({ ...p, transferPenaltyMin: p.maxMinutes }),
  },
  {
    id: "sore-feet", emoji: "🩹", label: "Sore feet", description: "Walking at 3 km/h.",
    apply: (p) => ({ ...p, walkSpeedKmh: 3 }),
  },
];

export const twistById = (id: string) => TWISTS.find((t) => t.id === id);

export function dailyParams(twist: Twist, lon: number, lat: number, meta: Meta): RouteParams {
  const period = periodIdx(meta, SCORE_SETTINGS.periodId);
  return twist.apply(scoreParams(lon, lat, period, meta.modeGroups.length), meta);
}

export interface Puzzle {
  n: number;
  date: string;
  twist: string;
  name: string;
  center: [number, number];
  radiusM: number;
  best: { lon: number; lat: number; km2: number };
  /** Every grid point inside the area: [lon, lat, km2]. */
  grid: [number, number, number][];
}

export interface PuzzleFile {
  generated: string;
  /** meta.generated of the graph the puzzles were scored on. */
  graphGenerated: string;
  puzzles: Puzzle[];
}

export interface Guess {
  lon: number;
  lat: number;
  km2: number;
}

/** Guess as % of the day's best grid spot (a guess between grid points can exceed it; capped). */
export const pctOfBest = (km2: number, puzzle: Puzzle) => Math.min(100, (100 * km2) / puzzle.best.km2);

export function tile(pct: number): string {
  if (pct >= 95) return "🟩";
  if (pct >= 80) return "🟨";
  if (pct >= 60) return "🟧";
  return "🟥";
}

export function localDateKey(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayNumber(date: string): number {
  const ms = Date.parse(`${date}T12:00:00Z`) - Date.parse(`${EPOCH}T12:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

export function metersBetween(a: [number, number], b: [number, number]): number {
  const k = 111_195;
  const dx = (a[0] - b[0]) * k * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (a[1] - b[1]) * k;
  return Math.hypot(dx, dy);
}
