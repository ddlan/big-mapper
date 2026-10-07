// Generates public/data/daily.json: one puzzle per day (play area, twist, and
// an exhaustive grid of scores inside the area). Re-run after rebuilding the graph.
//
//   npm run daily [-- --start 2026-09-30 --days 30]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EPOCH, TWISTS, dailyParams, dayNumber, metersBetween, type Puzzle, type PuzzleFile } from "../src/daily";
import { decodeGraph, type Meta } from "../src/graph";
import { Router } from "../src/router";

const RADIUS_M = 1000;
const GRID_M = 150;
const MIN_BEST_KM2 = 10; // area must have real transit under the twist
const MAX_MEDIAN_RATIO = 0.8; // a random spot shouldn't already be ~best
const MIN_LAND_SHARE = 0.6; // skip areas that are mostly water
const MAX_CANDIDATES = 40;

const dataDir = fileURLToPath(new URL("../public/data/", import.meta.url));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const start = arg("start", EPOCH);
const days = Number(arg("days", "30"));

const meta: Meta = JSON.parse(readFileSync(dataDir + "meta.json", "utf8"));
const buf = readFileSync(dataDir + "graph.bin");
const g = decodeGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const router = new Router(g, meta);

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each twist once per cycle, in a seeded shuffled order. */
function twistFor(n: number) {
  const cycle = Math.floor((n - 1) / TWISTS.length);
  const order = TWISTS.map((_, i) => i);
  const rand = prng(0x7157 + cycle);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return TWISTS[order[(n - 1) % TWISTS.length]];
}

const offset = ([lon, lat]: [number, number], dx: number, dy: number): [number, number] => [
  lon + dx / (111_195 * Math.cos((lat * Math.PI) / 180)),
  lat + dy / 111_195,
];

function nearestStopName(p: [number, number]): string {
  let best = Infinity, name = "";
  for (let i = 0; i < g.nStop; i++) {
    const d = metersBetween(p, [g.lon[g.nStreet + i], g.lat[g.nStreet + i]]);
    if (d < best) {
      best = d;
      name = meta.stops[i].name;
    }
  }
  return name;
}

function makePuzzle(date: string): Puzzle {
  const n = dayNumber(date);
  const twist = twistFor(n);
  const score = (p: [number, number]) => router.compute(dailyParams(twist, p[0], p[1], meta)).stats.reachableKm2;
  const rand = prng(n * 7919);

  for (let attempt = 0; attempt < MAX_CANDIDATES; attempt++) {
    const node = Math.floor(rand() * g.nStreet);
    const center: [number, number] = [g.lon[node], g.lat[node]];

    // Cheap pre-screen: center + 6 points on a ring.
    const probe = [center, ...Array.from({ length: 6 }, (_, k) => {
      const a = (k / 6) * 2 * Math.PI;
      return offset(center, 0.6 * RADIUS_M * Math.cos(a), 0.6 * RADIUS_M * Math.sin(a));
    })].map(score);
    if (Math.max(...probe) < MIN_BEST_KM2 || Math.min(...probe) / Math.max(...probe) > 0.9) continue;

    // Exhaustive grid over the area.
    const grid: [number, number, number][] = [];
    let possible = 0;
    for (let dy = -RADIUS_M; dy <= RADIUS_M; dy += GRID_M) {
      for (let dx = -RADIUS_M; dx <= RADIUS_M; dx += GRID_M) {
        if (Math.hypot(dx, dy) > RADIUS_M) continue;
        possible++;
        const p = offset(center, dx, dy);
        if (router.distanceToStreet(p[0], p[1], GRID_M) === Infinity) continue;
        grid.push([+p[0].toFixed(5), +p[1].toFixed(5), Math.round(score(p) * 100) / 100]);
      }
    }
    if (grid.length < MIN_LAND_SHARE * possible) continue;
    const sorted = grid.map((c) => c[2]).sort((a, b) => a - b);
    const best = grid.reduce((a, b) => (b[2] > a[2] ? b : a));
    const median = sorted[Math.floor(sorted.length / 2)];
    if (best[2] < MIN_BEST_KM2 || median / best[2] > MAX_MEDIAN_RATIO) continue;

    console.log(`#${n} ${date} ${twist.emoji} ${twist.label}: best ${best[2]} km², median ${median} ` +
      `(${grid.length} pts, attempt ${attempt + 1})`);
    return {
      n, date, twist: twist.id, name: nearestStopName(center), center: [+center[0].toFixed(5), +center[1].toFixed(5)],
      radiusM: RADIUS_M, best: { lon: best[0], lat: best[1], km2: best[2] }, grid,
    };
  }
  throw new Error(`No suitable area found for ${date} (${twist.id}) after ${MAX_CANDIDATES} candidates`);
}

// Merge into the existing file so extending the range keeps earlier days stable.
const outPath = dataDir + "daily.json";
const existing: PuzzleFile | null = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;
const byDate = new Map((existing?.graphGenerated === meta.generated ? existing.puzzles : []).map((p) => [p.date, p]));

const t0 = performance.now();
for (let i = 0; i < days; i++) {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  const date = d.toISOString().slice(0, 10);
  byDate.set(date, makePuzzle(date));
  writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    graphGenerated: meta.generated,
    puzzles: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  } satisfies PuzzleFile));
}
console.log(`Wrote ${byDate.size} puzzles to ${outPath} in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
