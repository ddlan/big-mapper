// Decoder for graph.bin.gz (format v3, documented in pipeline/graph_format.py).
// The file stores only what can't be derived; this rebuilds the full CSR graph.

export const WALK = 0;
export const BOARD = 1;
export const RIDE = 2;
export const ALIGHT = 3;

export interface RouteMeta {
  agency: string;
  shortName: string;
  longName: string;
  type: number;
  group: number;
  color: string;
}

export interface Meta {
  version: number;
  generated: string;
  bbox: [number, number, number, number];
  modeGroups: string[];
  periods: { id: string; label: string }[];
  agencies: string[];
  routes: RouteMeta[];
  stops: { name: string }[];
}

export interface Graph {
  nStreet: number;
  nStop: number;
  nRouteNode: number;
  nodeCount: number;
  lon: Float32Array;
  lat: Float32Array;
  offsets: Uint32Array;
  targets: Uint32Array;
  weights: Uint16Array;
  routeOfRouteNode: Uint16Array;
  kinds: Uint8Array;
  /** Index of the first edge belonging to a route node; route-node edges run to the end. */
  rnEdgeBase: number;
  nPeriod: number;
  /** [period][edge - rnEdgeBase] RIDE seconds; NO_SERVICE if the hop isn't served then. */
  periodWeights: Uint16Array;
}

export const NO_SERVICE = 65535;

/** Gunzips if needed: a host may already have decoded the gzip transfer, so sniff the magic bytes. */
export async function gunzipIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Sequential LEB128 reader over one stream. */
class Varints {
  private i: number;
  constructor(private bytes: Uint8Array, start: number, private end: number) {
    this.i = start;
  }
  next(): number {
    const b = this.bytes;
    let v = 0, shift = 0, c: number;
    do {
      c = b[this.i++];
      v += (c & 0x7f) * 2 ** shift; // not <<, values may exceed 31 bits
      shift += 7;
    } while (c & 0x80);
    return v;
  }
  /** Zigzag-signed. */
  nextSigned(): number {
    const v = this.next();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }
  get done() {
    return this.i >= this.end;
  }
}

export function decodeGraph(buf: ArrayBuffer): Graph {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== "MMG1") throw new Error(`Bad graph file (magic ${magic})`);
  const view = new DataView(buf);
  const h = (i: number) => view.getUint32(4 + 4 * i, true);
  const [version, nStreet, nStop, nRouteNode, nWalk, nRide, nPeriod] = [0, 1, 2, 3, 4, 5, 6].map(h);
  if (version !== 3) throw new Error(`Unsupported graph version ${version}; rebuild with the pipeline`);

  const bytes = new Uint8Array(buf);
  const streams: Varints[] = [];
  for (let off = 32; off < buf.byteLength; ) {
    const len = view.getUint32(off, true);
    streams.push(new Varints(bytes, off + 4, off + 4 + len));
    off += 4 + len;
  }
  if (streams.length !== 13) throw new Error(`Graph has ${streams.length} streams, expected 13`);
  const [sLon, sLat, sUpDeg, sWalkDelta, sWalkM, sSnap, sSnapM, sRnStop, sRnRoute, sRideDeg, sRideTo, sRideS, sPeriod] =
    streams;

  const nCoord = nStreet + nStop;
  const n = nCoord + nRouteNode;
  const rnBase = nCoord;
  const lon = new Float32Array(n);
  const lat = new Float32Array(n);
  for (let i = 0, x = 0, y = 0; i < nCoord; i++) {
    x += sLon.nextSigned();
    y += sLat.nextSigned();
    lon[i] = x / 1e6;
    lat[i] = y / 1e6;
  }

  // Parse the stored edges into flat arrays, counting degrees as we go.
  const deg = new Uint32Array(n);
  const walkU = new Uint32Array(nWalk), walkV = new Uint32Array(nWalk), walkM = new Uint16Array(nWalk);
  for (let u = 0, e = 0; u < nStreet; u++) {
    const k = sUpDeg.next();
    let v = u;
    for (let j = 0; j < k; j++, e++) {
      v += sWalkDelta.next();
      walkU[e] = u;
      walkV[e] = v;
      walkM[e] = sWalkM.next();
      deg[u]++;
      deg[v]++;
    }
  }
  const snapStreet = new Uint32Array(nStop), snapM = new Uint16Array(nStop);
  for (let i = 0, t = 0; i < nStop; i++) {
    t += sSnap.nextSigned();
    snapStreet[i] = t;
    snapM[i] = sSnapM.next();
    deg[nStreet + i]++; // stop -> street
    deg[t]++; // street -> stop
  }
  const rnStop = new Uint32Array(nRouteNode);
  const routeOfRouteNode = new Uint16Array(nRouteNode);
  const rideDeg = new Uint32Array(nRouteNode);
  for (let r = 0, s = 0; r < nRouteNode; r++) {
    s += sRnStop.next();
    rnStop[r] = nStreet + s;
    routeOfRouteNode[r] = sRnRoute.next();
    rideDeg[r] = sRideDeg.next();
    deg[nStreet + s]++; // BOARD
    deg[rnBase + r] += 1 + rideDeg[r]; // ALIGHT + rides
  }

  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + deg[i];
  const nEdge = offsets[n];
  const targets = new Uint32Array(nEdge);
  const weights = new Uint16Array(nEdge);
  const kinds = new Uint8Array(nEdge);
  const rnEdgeBase = offsets[rnBase];
  const periodWeights = new Uint16Array(nPeriod * (nEdge - rnEdgeBase)).fill(NO_SERVICE);
  const cursor = offsets.slice(0, n);
  const add = (from: number, to: number, w: number, kind: number) => {
    const e = cursor[from]++;
    targets[e] = to;
    weights[e] = w;
    kinds[e] = kind;
    return e;
  };

  for (let e = 0; e < nWalk; e++) {
    add(walkU[e], walkV[e], walkM[e], WALK);
    add(walkV[e], walkU[e], walkM[e], WALK);
  }
  for (let i = 0; i < nStop; i++) {
    add(nStreet + i, snapStreet[i], snapM[i], WALK);
    add(snapStreet[i], nStreet + i, snapM[i], WALK);
  }
  const perPeriod = nEdge - rnEdgeBase;
  let ride = 0;
  for (let r = 0; r < nRouteNode; r++) {
    const node = rnBase + r;
    add(rnStop[r], node, 0, BOARD);
    add(node, rnStop[r], 0, ALIGHT);
    for (let j = 0; j < rideDeg[r]; j++, ride++) {
      const e = add(node, rnBase + r + sRideTo.nextSigned(), sRideS.next(), RIDE);
      for (let p = 0; p < nPeriod; p++) {
        const v = sPeriod.next();
        periodWeights[p * perPeriod + (e - rnEdgeBase)] = v === 0 ? NO_SERVICE : v - 1;
      }
    }
  }
  for (let r = 0; r < nRouteNode; r++) {
    lon[rnBase + r] = lon[rnStop[r]];
    lat[rnBase + r] = lat[rnStop[r]];
  }
  if (ride !== nRide || !sPeriod.done || !sRideTo.done || !sWalkDelta.done) {
    throw new Error("Graph streams not fully consumed; file is corrupt or from another version");
  }

  return {
    nStreet, nStop, nRouteNode, nodeCount: n, lon, lat, offsets, targets, weights, routeOfRouteNode, kinds,
    rnEdgeBase, nPeriod, periodWeights,
  };
}
