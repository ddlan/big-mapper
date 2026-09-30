// Builds public/data/score-dist.json: connectivity scores of randomly sampled
// origins, so the app can show a percentile. Re-run after rebuilding the graph.
//
//   npm run score-dist [-- --samples 2000]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeGraph, type Meta } from "../src/graph";
import { Router } from "../src/router";
import { SCORE_SETTINGS, type ScoreDistribution, scoreParams } from "../src/score";

const dataDir = fileURLToPath(new URL("../public/data/", import.meta.url));
const argIdx = process.argv.indexOf("--samples");
const samples = argIdx > 0 ? Number(process.argv[argIdx + 1]) : 2000;

const meta: Meta = JSON.parse(readFileSync(dataDir + "meta.json", "utf8"));
const buf = readFileSync(dataDir + "graph.bin");
const graph = decodeGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const router = new Router(graph, meta);
const period = meta.periods.findIndex((p) => p.id === SCORE_SETTINGS.periodId);
if (period < 0) throw new Error(`Period ${SCORE_SETTINGS.periodId} not in meta.json`);

// Deterministic PRNG (mulberry32) so reruns on the same graph match.
let seed = 0x5eed;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Origins are random street nodes: intersections are dense where people live
// and sparse in hills and farmland, so this roughly weights by urbanization.
const scores: number[] = [];
const t0 = performance.now();
for (let i = 0; i < samples; i++) {
  const n = Math.floor(rand() * graph.nStreet);
  const iso = router.compute(scoreParams(graph.lon[n], graph.lat[n], period, meta.modeGroups.length));
  scores.push(Math.round(iso.stats.reachableKm2 * 100) / 100);
  if ((i + 1) % 200 === 0) {
    const s = (performance.now() - t0) / 1000;
    console.log(`${i + 1}/${samples}  ${s.toFixed(0)}s elapsed, ~${((s / (i + 1)) * (samples - i - 1)).toFixed(0)}s left`);
  }
}
scores.sort((a, b) => a - b);

const q = (f: number) => scores[Math.min(scores.length - 1, Math.floor(f * scores.length))];
console.log(`km² at percentiles 10/25/50/75/90/99/max: ${[0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1].map(q).join(" / ")}`);

const out: ScoreDistribution = {
  generated: new Date().toISOString(),
  settings: SCORE_SETTINGS,
  samples,
  sorted: scores,
};
writeFileSync(dataDir + "score-dist.json", JSON.stringify(out));
console.log(`Wrote ${dataDir}score-dist.json`);
