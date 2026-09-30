// Owns the graph and runs routing off the UI thread.

import { decodeGraph, type Meta } from "./graph";
import { HopShapes, type Isochrone, type Itinerary, Router, type RouteParams } from "./router";

export type WorkerRequest =
  | { type: "route"; id: number; params: RouteParams }
  | { type: "path"; id: number; lon: number; lat: number; clickRadiusM: number };

export type WorkerResponse =
  | { type: "ready"; meta: Meta; nodeCount: number }
  | { type: "error"; message: string }
  | { type: "result"; id: number; iso: Isochrone }
  | { type: "path"; id: number; itinerary: Itinerary | null };

let router: Router | null = null;
const queue: WorkerRequest[] = [];

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

async function init() {
  try {
    const base = import.meta.env.BASE_URL;
    const [metaRes, graphRes] = await Promise.all([fetch(`${base}data/meta.json`), fetch(`${base}data/graph.bin`)]);
    if (!metaRes.ok || !graphRes.ok) throw new Error("Graph data not found. Run the pipeline (see README).");
    const meta: Meta = await metaRes.json();
    const graph = decodeGraph(await graphRes.arrayBuffer());
    router = new Router(graph, meta);
    post({ type: "ready", meta, nodeCount: graph.nodeCount });
    while (queue.length) handle(queue.shift()!);
    loadShapes(base);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** Optional: without shapes.bin, ride legs are drawn as straight lines between stops. */
async function loadShapes(base: string) {
  try {
    const res = await fetch(`${base}data/shapes.bin`);
    if (res.ok) router?.setShapes(HopShapes.decode(await res.arrayBuffer()));
  } catch (e) {
    console.warn("Could not load shapes.bin", e);
  }
}

function handle(req: WorkerRequest) {
  if (!router) {
    queue.push(req);
    return;
  }
  if (req.type === "route") {
    const iso = router.compute(req.params);
    post({ type: "result", id: req.id, iso }, [iso.times.buffer]);
  } else {
    post({ type: "path", id: req.id, itinerary: router.path(req.lon, req.lat, req.clickRadiusM) });
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => handle(e.data);
init();
