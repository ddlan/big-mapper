// Generates public/data/daily.json: one puzzle per day (play area, twist, and
// an exhaustive grid of scores inside the area). Re-run after rebuilding the graph.
//
//   npm run daily [-- --start 2026-09-30 --days 30 --force]
//
// Needs public/data/places.json (pipeline/places.py) for neighbourhood centers
// and names, and network access to OpenFreeMap tiles for the water check.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EPOCH, TWISTS, dailyParams, dayNumber, metersBetween, type Puzzle, type PuzzleFile } from "../src/daily";
import { decodeGraph, type Meta } from "../src/graph";
import { Router } from "../src/router";
import { WaterIndex } from "./water";

const RADIUS_M = 1000;
const GRID_M = 150;
const MIN_BEST_KM2 = 10; // area must have real transit under the twist
const MAX_MEDIAN_RATIO = 0.8; // a random spot shouldn't already be ~best
const MIN_LAND_SHARE = 0.6; // skip areas that are mostly water
const MAX_CANDIDATES = 40;
const NEIGHBOURHOOD_TYPES = new Set(["neighbourhood", "suburb", "quarter"]);
const RECENT_DAYS = 14; // no area within RECENT_M of one used this many days before
const RECENT_M = 2500;

const dataDir = fileURLToPath(new URL("../public/data/", import.meta.url));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const start = arg("start", EPOCH);
const days = Number(arg("days", "30"));
const force = process.argv.includes("--force");

const meta: Meta = JSON.parse(readFileSync(dataDir + "meta.json", "utf8"));
const buf = readFileSync(dataDir + "graph.bin");
const g = decodeGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const router = new Router(g, meta);
const water = new WaterIndex();

interface Place { name: string; type: string; city: string; lon: number; lat: number }
const places: Place[] = JSON.parse(readFileSync(dataDir + "places.json", "utf8"));

// Puzzle centers are named neighbourhoods, weighted by how many transit stops
// are within 1 km: favors places people know and that have service to play with,
// without excluding quieter areas entirely.
const candidates = places
  .filter((p) => NEIGHBOURHOOD_TYPES.has(p.type))
  .map((p) => {
    let stops = 0;
    for (let i = 0; i < g.nStop; i++) {
      if (metersBetween([p.lon, p.lat], [g.lon[g.nStreet + i], g.lat[g.nStreet + i]]) <= 1000) stops++;
    }
    return { place: p, weight: Math.min(stops, 60) };
  })
  .filter((c) => c.weight >= 5);
console.log(`${candidates.length} candidate neighbourhoods`);
const placeLabel = (p: Place) => (p.city && p.city !== p.name ? `${p.name}, ${p.city}` : p.name);

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Each twist once per cycle, in a seeded shuffled order. A cycle is reshuffled
 * if it would start with one of the previous cycle's last 3 twists, so no twist
 * repeats within 3 days across the boundary.
 */
const cycleOrders: number[][] = [];
function cycleOrder(cycle: number): number[] {
  if (cycleOrders[cycle]) return cycleOrders[cycle];
  const prevTail = cycle > 0 ? cycleOrder(cycle - 1).slice(-3) : [];
  const rand = prng(0x7157 + cycle);
  let order: number[];
  do {
    order = TWISTS.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } while (order.slice(0, 3).some((t) => prevTail.includes(t)));
  return (cycleOrders[cycle] = order);
}

function twistFor(n: number) {
  return TWISTS[cycleOrder(Math.floor((n - 1) / TWISTS.length))[(n - 1) % TWISTS.length]];
}

const offset = ([lon, lat]: [number, number], dx: number, dy: number): [number, number] => [
  lon + dx / (111_195 * Math.cos((lat * Math.PI) / 180)),
  lat + dy / 111_195,
];

function pickCandidate(rand: () => number, used: Set<string>, recent: [number, number][]) {
  const pool = candidates.filter((c) => !used.has(placeLabel(c.place)) &&
    recent.every((r) => metersBetween(r, [c.place.lon, c.place.lat]) > RECENT_M));
  let r = rand() * pool.reduce((a, c) => a + c.weight, 0);
  for (const c of pool) if ((r -= c.weight) <= 0) return c.place;
  return pool[pool.length - 1].place;
}

async function makePuzzle(date: string, used: Set<string>, recent: [number, number][]): Promise<Puzzle> {
  const n = dayNumber(date);
  const twist = twistFor(n);
  const score = (p: [number, number]) => router.compute(dailyParams(twist, p[0], p[1], meta)).stats.reachableKm2;
  const rand = prng(n * 7919);

  for (let attempt = 0; attempt < MAX_CANDIDATES; attempt++) {
    const place = pickCandidate(rand, used, recent);
    used.add(placeLabel(place)); // don't retry a rejected place either
    const center: [number, number] = [place.lon, place.lat];

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
        // Round first so the water check sees exactly the coordinates we store.
        const p = offset(center, dx, dy).map((v) => +v.toFixed(5)) as [number, number];
        // Guesses must be on land near a street; the app enforces the same water rule.
        if (router.distanceToStreet(p[0], p[1], GRID_M) === Infinity || await water.isWater(p[0], p[1])) continue;
        grid.push([p[0], p[1], Math.round(score(p) * 100) / 100]);
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
      n, date, twist: twist.id, name: placeLabel(place), center: [+center[0].toFixed(5), +center[1].toFixed(5)],
      radiusM: RADIUS_M, best: { lon: best[0], lat: best[1], km2: best[2] }, grid,
    };
  }
  throw new Error(`No suitable area found for ${date} (${twist.id}) after ${MAX_CANDIDATES} candidates`);
}

// Merge into the existing file so extending the range keeps earlier days stable.
const outPath = dataDir + "daily.json";
const existing: PuzzleFile | null = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : null;
const keep = !force && existing?.graphGenerated === meta.generated ? existing.puzzles : [];
const byDate = new Map(keep.map((p) => [p.date, p]));
const used = new Set(keep.map((p) => p.name));

const t0 = performance.now();
for (let i = 0; i < days; i++) {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  const date = d.toISOString().slice(0, 10);
  if (byDate.has(date)) continue;
  const recent = [...byDate.values()]
    .filter((p) => p.date < date && Date.parse(date) - Date.parse(p.date) <= RECENT_DAYS * 86_400_000)
    .map((p) => p.center);
  byDate.set(date, await makePuzzle(date, used, recent));
  writeFileSync(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    graphGenerated: meta.generated,
    puzzles: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  } satisfies PuzzleFile));
}
console.log(`Wrote ${byDate.size} puzzles to ${outPath} in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
