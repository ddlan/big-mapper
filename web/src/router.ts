// Time-independent Dijkstra over the walk + transit graph, then rasterization
// of travel times onto a Web Mercator grid. Pure functions, no DOM.

import { ALIGHT, BOARD, type Graph, type Meta, NO_SERVICE, RIDE, WALK } from "./graph";
import { lonToMercX, latToMercY, metersPerMercUnit } from "./mercator";

export interface RouteParams {
  lon: number;
  lat: number;
  maxMinutes: number;
  walkSpeedKmh: number;
  /** Penalty for each boarding after the first, in minutes. Counted as travel time. */
  transferPenaltyMin: number;
  /** Penalty for the first boarding (0 = fully optimistic). */
  initialWaitMin: number;
  /** Indexed by meta.modeGroups. */
  modes: boolean[];
  /** Index into meta.periods, or -1 for any time (fastest trip regardless of when it runs). */
  period: number;
}

export interface Isochrone {
  width: number;
  height: number;
  /** Mercator (0..1) coords of the grid's top-left corner, and cell size in mercator units. */
  x0: number;
  y0: number;
  cell: number;
  /** Seconds per cell, row-major from the top; Infinity where unreachable. */
  times: Float32Array;
  maxSeconds: number;
  stats: { dijkstraMs: number; rasterMs: number; stopsReached: number; seeds: number; reachableKm2: number };
}

export interface WalkLeg {
  kind: "walk";
  seconds: number;
  meters: number;
  coords: [number, number][];
}

export interface RideLeg {
  kind: "ride";
  /** Index into meta.routes. */
  route: number;
  fromStop: string;
  toStop: string;
  /** In-vehicle time. */
  seconds: number;
  /** Initial-wait or transfer penalty charged when boarding. */
  penaltySeconds: number;
  stops: number;
  coords: [number, number][];
}

export type Leg = WalkLeg | RideLeg;

export interface Itinerary {
  totalSeconds: number;
  finalWalkMeters: number;
  /** Set when the click was just outside the reachable area and the route goes to the nearest reachable point. */
  snappedTo?: { lon: number; lat: number; meters: number };
  legs: Leg[];
}

/** Display geometry for RIDE edges, keyed by (from route node, to route node). */
export class HopShapes {
  private index = new Map<number, number>();

  constructor(
    private offsets: Uint32Array,
    private coords: Float32Array,
    from: Uint32Array,
    to: Uint32Array,
  ) {
    for (let h = 0; h < from.length; h++) this.index.set(from[h] * 4_194_304 + to[h], h);
  }

  static decode(buf: ArrayBuffer): HopShapes {
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
    if (magic !== "MMS1") throw new Error(`Bad shapes file (magic ${magic})`);
    const [, nHop, nPoint] = new Uint32Array(buf, 4, 3);
    let off = 16;
    const from = new Uint32Array(buf, off, nHop); off += nHop * 4;
    const to = new Uint32Array(buf, off, nHop); off += nHop * 4;
    const offsets = new Uint32Array(buf, off, nHop + 1); off += (nHop + 1) * 4;
    const coords = new Float32Array(buf, off, nPoint * 2);
    return new HopShapes(offsets, coords, from, to);
  }

  get(from: number, to: number): [number, number][] | null {
    const h = this.index.get(from * 4_194_304 + to);
    if (h === undefined) return null;
    const out: [number, number][] = [];
    for (let i = this.offsets[h]; i < this.offsets[h + 1]; i++) out.push([this.coords[2 * i], this.coords[2 * i + 1]]);
    return out;
  }
}

const SEED_RADIUS_M = 300;
/**
 * How far from a click to look for a reachable node. Larger than the raster's
 * splat radius plus a cell, so anything painted on the map is clickable, and
 * small reachable islands have a usable hit area.
 */
const CLICK_RADIUS_M = 400;
const SPLAT_RADIUS_M = 250;
const TARGET_CELL_M = 40;
const MAX_CELLS = 4_000_000;

class MinHeap {
  keys = new Float64Array(1 << 16);
  ids = new Uint32Array(1 << 16);
  size = 0;

  push(key: number, id: number) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const i = new Uint32Array(this.size * 2);
      i.set(this.ids);
      this.ids = i;
    }
    const { keys, ids } = this;
    let j = this.size++;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (keys[p] <= key) break;
      keys[j] = keys[p];
      ids[j] = ids[p];
      j = p;
    }
    keys[j] = key;
    ids[j] = id;
  }

  /** Pops the min; returns its id, with its key in `lastKey`. */
  lastKey = 0;
  pop(): number {
    const { keys, ids } = this;
    const topId = ids[0];
    this.lastKey = keys[0];
    const n = --this.size;
    const key = keys[n];
    const id = ids[n];
    let j = 0;
    for (;;) {
      let c = 2 * j + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= key) break;
      keys[j] = keys[c];
      ids[j] = ids[c];
      j = c;
    }
    keys[j] = key;
    ids[j] = id;
    return topId;
  }
}

/** Uniform grid over street nodes for nearby-node lookups. */
class StreetIndex {
  private cellDeg = 0.003; // ~300 m
  private cells = new Map<number, number[]>();

  constructor(private g: Graph) {
    for (let i = 0; i < g.nStreet; i++) {
      const k = this.key(Math.floor(g.lon[i] / this.cellDeg), Math.floor(g.lat[i] / this.cellDeg));
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    }
  }

  private key(cx: number, cy: number) {
    return (cx + 100_000) * 200_000 + (cy + 100_000);
  }

  /** Street nodes within radius (meters), with distances. Falls back to the nearest few if none. */
  near(lon: number, lat: number, radiusM: number): { node: number; dist: number }[] {
    const { g } = this;
    const mPerDegLat = 111_195;
    const mPerDegLon = mPerDegLat * Math.cos((lat * Math.PI) / 180);
    const out: { node: number; dist: number }[] = [];
    for (let ring = 1; ring <= 20 && out.length === 0; ring *= 2) {
      const r = radiusM * ring;
      const cx0 = Math.floor((lon - r / mPerDegLon) / this.cellDeg);
      const cx1 = Math.floor((lon + r / mPerDegLon) / this.cellDeg);
      const cy0 = Math.floor((lat - r / mPerDegLat) / this.cellDeg);
      const cy1 = Math.floor((lat + r / mPerDegLat) / this.cellDeg);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (const i of this.cells.get(this.key(cx, cy)) ?? []) {
            const dx = (g.lon[i] - lon) * mPerDegLon;
            const dy = (g.lat[i] - lat) * mPerDegLat;
            const d = Math.hypot(dx, dy);
            if (d <= r) out.push({ node: i, dist: d });
          }
        }
      }
    }
    return out;
  }
}

export class Router {
  private index: StreetIndex;
  private dist: Float64Array;
  /** Predecessor state id per state id (-1 = seed / unreached), for path reconstruction. */
  private pred: Int32Array;
  private heap = new MinHeap();
  private last: { params: RouteParams; best: Float64Array } | null = null;
  private shapes: HopShapes | null = null;
  private routeNodeGroup: Uint8Array;
  private mercX: Float64Array;
  private mercY: Float64Array;

  constructor(private g: Graph, private meta: Meta) {
    this.index = new StreetIndex(g);
    this.dist = new Float64Array(2 * g.nodeCount);
    this.pred = new Int32Array(2 * g.nodeCount);
    this.routeNodeGroup = new Uint8Array(g.nRouteNode);
    for (let i = 0; i < g.nRouteNode; i++) this.routeNodeGroup[i] = meta.routes[g.routeOfRouteNode[i]].group;
    const m = g.nStreet + g.nStop;
    this.mercX = new Float64Array(m);
    this.mercY = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      this.mercX[i] = lonToMercX(g.lon[i]);
      this.mercY[i] = latToMercY(g.lat[i]);
    }
  }

  /**
   * Returns best cost (seconds) per street+stop node; Infinity if unreached.
   *
   * The search runs over a doubled state space: state 0 = haven't boarded
   * yet, state 1 = have boarded at least once. Boarding from state 0 costs
   * the initial wait, from state 1 the transfer penalty.
   */
  private search(p: RouteParams): { best: Float64Array; seeds: number } {
    const { g, dist, pred, heap } = this;
    const N = g.nodeCount;
    const maxCost = p.maxMinutes * 60;
    const speed = p.walkSpeedKmh / 3.6;
    const firstBoard = p.initialWaitMin * 60;
    const transfer = p.transferPenaltyMin * 60;
    const rnBase = g.nStreet + g.nStop;
    const allowed = p.modes;
    const { offsets, targets, weights, kinds } = g;
    const periodW = p.period >= 0 ? g.periodWeights : null;
    const periodOff = p.period * (g.targets.length - g.rnEdgeBase) - g.rnEdgeBase;

    dist.fill(Infinity);
    pred.fill(-1);
    heap.size = 0;
    const seeds = this.index.near(p.lon, p.lat, SEED_RADIUS_M);
    for (const { node, dist: d } of seeds) {
      const c = d / speed;
      if (c < dist[node]) {
        dist[node] = c;
        heap.push(c, node);
      }
    }

    while (heap.size > 0) {
      const id = heap.pop();
      const cost = heap.lastKey;
      if (cost > dist[id]) continue;
      const boarded = id >= N;
      const n = boarded ? id - N : id;
      const stateBase = boarded ? N : 0;
      for (let e = offsets[n], end = offsets[n + 1]; e < end; e++) {
        const t = targets[e];
        let c: number;
        let base = stateBase;
        switch (kinds[e]) {
          case WALK:
            c = weights[e] / speed;
            break;
          case RIDE:
            if (periodW) {
              c = periodW[periodOff + e];
              if (c === NO_SERVICE) continue;
            } else {
              c = weights[e];
            }
            break;
          case BOARD:
            if (!allowed[this.routeNodeGroup[t - rnBase]]) continue;
            c = boarded ? transfer : firstBoard;
            base = N;
            break;
          case ALIGHT:
            c = 0;
            break;
          default:
            continue;
        }
        const nc = cost + c;
        const tid = t + base;
        // A boarded label is dominated by an equal-or-cheaper unboarded label
        // at the same node (the unboarded one also has a cheaper next boarding).
        if (base === N && dist[t] <= nc) continue;
        if (nc <= maxCost && nc < dist[tid]) {
          dist[tid] = nc;
          pred[tid] = id;
          heap.push(nc, tid);
        }
      }
    }

    const m = g.nStreet + g.nStop;
    const best = new Float64Array(m);
    for (let i = 0; i < m; i++) best[i] = Math.min(dist[i], dist[i + N]);
    return { best, seeds: seeds.length };
  }

  compute(p: RouteParams): Isochrone {
    const t0 = performance.now();
    const { best, seeds } = this.search(p);
    this.last = { params: p, best };
    const t1 = performance.now();

    const { g } = this;
    const maxSeconds = p.maxMinutes * 60;
    const speed = p.walkSpeedKmh / 3.6;
    const mPerUnit = metersPerMercUnit(p.lat);

    // Grid bounds from reached nodes.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let stopsReached = 0;
    const reached: number[] = [];
    for (let i = 0; i < best.length; i++) {
      if (best[i] > maxSeconds) continue;
      reached.push(i);
      if (i >= g.nStreet) stopsReached++;
      const x = this.mercX[i];
      const y = this.mercY[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = SPLAT_RADIUS_M / mPerUnit;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    let cell = TARGET_CELL_M / mPerUnit;
    const area = (maxX - minX) * (maxY - minY);
    if (area / (cell * cell) > MAX_CELLS) cell = Math.sqrt(area / MAX_CELLS);
    const width = Math.max(1, Math.ceil((maxX - minX) / cell));
    const height = Math.max(1, Math.ceil((maxY - minY) / cell));
    const times = new Float32Array(width * height).fill(Infinity);

    // Seed each reached node's cell, then spread outward at walking speed
    // (up to SPLAT_RADIUS_M) with a two-pass chamfer distance transform. This
    // fills the gaps between streets in O(cells) instead of O(nodes * r^2).
    const cellM = cell * mPerUnit;
    const walked = new Float32Array(width * height).fill(Infinity);
    for (const i of reached) {
      const x = Math.min(width - 1, Math.floor((this.mercX[i] - minX) / cell));
      const y = Math.min(height - 1, Math.floor((this.mercY[i] - minY) / cell));
      const k = y * width + x;
      if (best[i] < times[k]) {
        times[k] = best[i];
        walked[k] = 0;
      }
    }
    const straight = cellM, diag = cellM * Math.SQRT2;
    const relax = (k: number, n: number, stepM: number) => {
      const w = walked[n] + stepM;
      if (w > SPLAT_RADIUS_M) return;
      const v = times[n] + stepM / speed;
      if (v < times[k] && v <= maxSeconds) {
        times[k] = v;
        walked[k] = w;
      }
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = y * width + x;
        if (x > 0) relax(k, k - 1, straight);
        if (y > 0) {
          relax(k, k - width, straight);
          if (x > 0) relax(k, k - width - 1, diag);
          if (x < width - 1) relax(k, k - width + 1, diag);
        }
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const k = y * width + x;
        if (x < width - 1) relax(k, k + 1, straight);
        if (y < height - 1) {
          relax(k, k + width, straight);
          if (x < width - 1) relax(k, k + width + 1, diag);
          if (x > 0) relax(k, k + width - 1, diag);
        }
      }
    }
    const t2 = performance.now();

    // Reachable area: painted cells times ground cell area (at the origin's latitude).
    let painted = 0;
    for (let k = 0; k < times.length; k++) if (times[k] <= maxSeconds) painted++;
    const reachableKm2 = (painted * cellM * cellM) / 1e6;

    return {
      width, height, x0: minX, y0: minY, cell, times, maxSeconds,
      stats: { dijkstraMs: t1 - t0, rasterMs: t2 - t1, stopsReached, seeds, reachableKm2 },
    };
  }

  setShapes(shapes: HopShapes) {
    this.shapes = shapes;
  }

  /** Itinerary from the last computed origin to a destination, or null if unreachable. */
  path(lon: number, lat: number, clickRadiusM = CLICK_RADIUS_M): Itinerary | null {
    if (!this.last) return null;
    const { g, dist, pred, meta } = this;
    const { params: p, best } = this.last;
    const N = g.nodeCount;
    const speed = p.walkSpeedKmh / 3.6;
    const maxSeconds = p.maxMinutes * 60;

    // Pick the nearby reached node that gives the best arrival including the
    // final walk. Also track the closest reached node as a fallback.
    let endNode = -1, endCost = Infinity, endWalk = 0;
    let nearNode = -1, nearDist = Infinity;
    const radius = Math.max(CLICK_RADIUS_M, clickRadiusM);
    for (const { node, dist: d } of this.index.near(lon, lat, radius)) {
      if (d > radius || !(best[node] <= maxSeconds)) continue;
      const c = best[node] + d / speed;
      if (c < endCost) {
        endCost = c;
        endNode = node;
        endWalk = d;
      }
      if (d < nearDist) {
        nearDist = d;
        nearNode = node;
      }
    }
    if (endNode < 0) return null;

    // Walking the rest of the way would exceed the limit (common at the fuzzy
    // edge of the colored area): route to the closest reachable point instead.
    let snappedTo: Itinerary["snappedTo"];
    if (endCost > maxSeconds) {
      endNode = nearNode;
      endCost = best[nearNode];
      endWalk = 0;
      snappedTo = { lon: g.lon[nearNode], lat: g.lat[nearNode], meters: nearDist };
      lon = snappedTo.lon;
      lat = snappedTo.lat;
    }

    // Trace back through the state graph.
    const ids: number[] = [];
    for (let id = dist[endNode] <= dist[endNode + N] ? endNode : endNode + N; id >= 0; id = pred[id]) ids.push(id);
    ids.reverse();

    const rnBase = g.nStreet + g.nStop;
    const kindOf = (n: number) => (n < g.nStreet ? "street" : n < rnBase ? "stop" : "route");
    const node = (id: number) => (id >= N ? id - N : id);
    const pt = (n: number): [number, number] => [g.lon[n], g.lat[n]];
    const stopName = (n: number) => meta.stops[n - g.nStreet]?.name ?? "";

    const legs: Leg[] = [];
    const first = node(ids[0]);
    let walk: WalkLeg = { kind: "walk", seconds: 0, meters: 0, coords: [[p.lon, p.lat], pt(first)] };
    let walkStart = 0;
    let ride: RideLeg | null = null;
    let rideStart = 0;

    for (let i = 1; i < ids.length; i++) {
      const prev = node(ids[i - 1]);
      const cur = node(ids[i]);
      const prevCost = dist[ids[i - 1]];
      const curCost = dist[ids[i]];
      const k = kindOf(cur);
      if (k === "route") {
        if (kindOf(prev) !== "route") {
          // BOARD: close the walk leg, open a ride leg.
          walk.seconds = prevCost - walkStart;
          walk.meters = walk.seconds * speed;
          if (walk.coords.length > 1 && walk.seconds > 0.5) legs.push(walk);
          const route = g.routeOfRouteNode[cur - rnBase];
          ride = {
            kind: "ride", route, fromStop: stopName(prev), toStop: "", seconds: 0,
            penaltySeconds: curCost - prevCost, stops: 0, coords: [pt(prev)],
          };
          rideStart = curCost;
        } else if (ride) {
          const hop = this.shapes?.get(prev, cur);
          const coords = hop ?? [pt(prev), pt(cur)];
          for (let j = 1; j < coords.length; j++) ride.coords.push(coords[j]);
          if (!hop) ride.coords[ride.coords.length - 1] = pt(cur);
          ride.stops++;
        }
      } else {
        if (kindOf(prev) === "route" && ride) {
          // ALIGHT: close the ride leg, open a new walk leg.
          ride.toStop = stopName(cur);
          ride.seconds = prevCost - rideStart;
          legs.push(ride);
          ride = null;
          walk = { kind: "walk", seconds: 0, meters: 0, coords: [pt(cur)] };
          walkStart = curCost;
        } else {
          walk.coords.push(pt(cur));
        }
      }
    }
    walk.coords.push([lon, lat]);
    walk.seconds = endCost - walkStart;
    walk.meters = walk.seconds * speed;
    if (walk.seconds > 0.5) legs.push(walk);

    return { totalSeconds: endCost, finalWalkMeters: endWalk, legs, snappedTo };
  }
}
