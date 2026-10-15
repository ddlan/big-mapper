// Point-in-water lookups against the same OpenFreeMap vector tiles the app's
// basemap draws, so the generator and the browser agree on what's water.
// Tiles are cached in data/raw/tiles/, so only areas not seen before need network.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

const TILEJSON = "https://tiles.openfreemap.org/planet";
const Z = 14;
const CACHE_DIR = fileURLToPath(new URL("../../data/raw/tiles/", import.meta.url));

type Ring = { x: number; y: number }[];

export class WaterIndex {
  private template: string | null = null;
  private tiles = new Map<string, Promise<{ extent: number; polygons: Ring[][] }>>();
  /** Tiles fetched over the network vs. read from the disk cache, for logging. */
  readonly stats = { fetched: 0, cached: 0 };

  private async tileUrl(x: number, y: number) {
    if (!this.template) {
      const tj = await (await fetch(TILEJSON)).json();
      this.template = tj.tiles[0] as string;
    }
    return this.template.replace("{z}", String(Z)).replace("{x}", String(x)).replace("{y}", String(y));
  }

  private load(x: number, y: number) {
    const key = `${x}/${y}`;
    let p = this.tiles.get(key);
    if (!p) {
      p = (async () => {
        const tile = new VectorTile(new PbfReader(await this.tileBytes(x, y)));
        const layer = tile.layers.water;
        const polygons: Ring[][] = [];
        let extent = 4096;
        if (layer) {
          extent = layer.extent;
          for (let i = 0; i < layer.length; i++) {
            const f = layer.feature(i);
            // Matches Positron's water layer: polygons, excluding tunnels.
            if (f.type === 3 && f.properties.brunnel !== "tunnel") polygons.push(f.loadGeometry());
          }
        }
        return { extent, polygons };
      })();
      this.tiles.set(key, p);
    }
    return p;
  }

  private async tileBytes(x: number, y: number): Promise<Uint8Array> {
    const path = `${CACHE_DIR}${Z}/${x}/${y}.pbf`;
    if (existsSync(path)) {
      this.stats.cached++;
      return readFileSync(path);
    }
    const res = await fetch(await this.tileUrl(x, y), { headers: { "User-Agent": "big-mapper/0.1" } });
    if (!res.ok) throw new Error(`tile ${Z}/${x}/${y}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    this.stats.fetched++;
    return bytes;
  }

  async isWater(lon: number, lat: number): Promise<boolean> {
    const n = 2 ** Z;
    const fx = ((lon + 180) / 360) * n;
    const latR = (lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const { extent, polygons } = await this.load(tx, ty);
    const px = (fx - tx) * extent, py = (fy - ty) * extent;
    // Even-odd over all rings of a feature handles holes (islands).
    for (const rings of polygons) {
      let inside = false;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        }
      }
      if (inside) return true;
    }
    return false;
  }
}
