// Decoder for graph.bin. Layout is documented in pipeline/build_graph.py.

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

export function decodeGraph(buf: ArrayBuffer): Graph {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== "MMG1") throw new Error(`Bad graph file (magic ${magic})`);
  const [version, nStreet, nStop, nRouteNode, nEdge, nPeriod] = new Uint32Array(buf, 4, 6);
  if (version !== 2) throw new Error(`Unsupported graph version ${version}; rebuild with the pipeline`);
  const n = nStreet + nStop + nRouteNode;

  let off = 32;
  const take = <T>(ctor: { new (b: ArrayBuffer, o: number, l: number): T; BYTES_PER_ELEMENT: number }, len: number): T => {
    const arr = new ctor(buf, off, len);
    off += len * ctor.BYTES_PER_ELEMENT;
    return arr;
  };
  const lon = take(Float32Array, n);
  const lat = take(Float32Array, n);
  const offsets = take(Uint32Array, n + 1);
  const targets = take(Uint32Array, nEdge);
  const weights = take(Uint16Array, nEdge);
  const routeOfRouteNode = take(Uint16Array, nRouteNode);
  const kinds = take(Uint8Array, nEdge);
  off += off % 2;
  const rnEdgeBase = offsets[nStreet + nStop];
  const periodWeights = take(Uint16Array, nPeriod * (nEdge - rnEdgeBase));

  return {
    nStreet, nStop, nRouteNode, nodeCount: n, lon, lat, offsets, targets, weights, routeOfRouteNode, kinds,
    rnEdgeBase, nPeriod, periodWeights,
  };
}
