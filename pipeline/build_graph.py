"""Build web/public/data/graph.bin + meta.json from GTFS zips and an OSM extract.

Graph model (all edges time-independent):

  street node  <-WALK(m)->  street node
  street node  <-WALK(m)->  stop node         (stop snapped to nearest street node)
  stop node    --BOARD-->   route node        (one route node per (route, stop))
  route node   --RIDE(s)--> route node        (fastest scheduled hop on that route, per service period)
  route node   --ALIGHT-->  stop node

Walking weights are stored in meters so walk speed is a runtime parameter.
BOARD carries no weight; the router applies the initial-wait / transfer
penalties there.

Binary layout (little-endian):
  header   8 x u32: magic "MMG1", version, nStreet, nStop, nRouteNode, nEdge, nPeriod, 0
  f32[N]   lon            N = nStreet + nStop + nRouteNode
  f32[N]   lat
  u32[N+1] edge offsets (CSR)
  u32[E]   edge target
  u16[E]   edge weight (meters for WALK, seconds for RIDE at any time, 0 otherwise)
  u16[R]   route index of each route node (into meta.routes)
  u8[E]    edge kind: 0 WALK, 1 BOARD, 2 RIDE, 3 ALIGHT
  (pad to 2 bytes)
  u16[P][Er] per-period RIDE seconds for the edges of route nodes, i.e. edges
             offsets[nStreet+nStop] .. E (Er of them); 65535 = no service then.
             Periods are listed in meta.periods.

shapes.bin holds display geometry for RIDE edges (little-endian):
  header   4 x u32: magic "MMS1", version, nHop, nPoint
  u32[H]   from route node
  u32[H]   to route node
  u32[H+1] point offsets
  f32[2P]  lon, lat interleaved
Hops without a GTFS shape get a straight line between the two stops.
"""

import argparse
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

import config
from geo import project_local_m
from streets import build_street_graph
from transit import MODE_GROUPS, PERIOD_COLS, PERIODS, load_transit

WALK, BOARD, RIDE, ALIGHT = 0, 1, 2, 3
VERSION = 2
NO_SERVICE = 65535


def polygon_bbox(poly):
    lons, lats = zip(*poly)
    return min(lons), min(lats), max(lons), max(lats)


def write_shapes(path: Path, hops, hop_shapes, rn_idx, stops):
    frm, to, lines = [], [], []
    shaped = 0
    for r, a, b in zip(hops["route"], hops["from_stop"], hops["to_stop"]):
        line = hop_shapes.get((r, a, b))
        if line is None:
            line = np.array([[stops.at[a, "lon"], stops.at[a, "lat"]],
                             [stops.at[b, "lon"], stops.at[b, "lat"]]], dtype=np.float32)
        else:
            shaped += 1
        frm.append(rn_idx[(r, a)])
        to.append(rn_idx[(r, b)])
        lines.append(line)
    offsets = np.zeros(len(lines) + 1, dtype=np.uint32)
    offsets[1:] = np.cumsum([len(ln) for ln in lines])
    coords = np.concatenate(lines).astype(np.float32) if lines else np.zeros((0, 2), np.float32)
    with open(path, "wb") as f:
        f.write(b"MMS1")
        f.write(struct.pack("<3I", 1, len(lines), len(coords)))
        f.write(np.asarray(frm, dtype=np.uint32).tobytes())
        f.write(np.asarray(to, dtype=np.uint32).tobytes())
        f.write(offsets.tobytes())
        f.write(coords.tobytes())
    print(f"  shapes: {shaped:,}/{len(lines):,} hops with GTFS geometry, "
          f"{len(coords):,} points, {path.stat().st_size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gtfs", nargs="*", type=Path, help=f"GTFS zips (default: all in {config.GTFS_DIR})")
    ap.add_argument("--osm", type=Path, default=config.OSM_PATH, help="OSM .pbf/.osm extract")
    ap.add_argument("--out", type=Path, default=config.OUT_DIR)
    ap.add_argument("--list-agencies", action="store_true", help="print agency include/exclude decisions and exit")
    args = ap.parse_args()

    gtfs_paths = args.gtfs or sorted(config.GTFS_DIR.glob("*.zip"))
    if not gtfs_paths:
        sys.exit(f"No GTFS zips found in {config.GTFS_DIR}. Run download.py first.")

    t0 = time.time()
    print(f"Loading GTFS: {', '.join(p.name for p in gtfs_paths)}")
    transit = load_transit(gtfs_paths)
    print(transit.agency_report.to_string(index=False))
    if args.list_agencies:
        return
    print(f"  {len(transit.routes):,} routes, {len(transit.stops):,} stops, {len(transit.hops):,} hops")

    if not args.osm.exists():
        sys.exit(f"OSM extract not found at {args.osm}. Run download.py first.")
    print(f"Loading streets from {args.osm.name} (this is the slow part)")
    streets = build_street_graph(args.osm, polygon_bbox(config.BAY_AREA_POLYGON))
    n_street = len(streets.lon)

    # Snap stops to nearest street node.
    lat0 = float(np.mean(streets.lat))
    tree = cKDTree(project_local_m(streets.lon, streets.lat, lat0))
    snap_m, snap_node = tree.query(project_local_m(transit.stops["lon"], transit.stops["lat"], lat0))
    ok = snap_m <= config.MAX_STOP_SNAP_METERS
    if (~ok).any():
        print(f"  dropping {(~ok).sum()} stops farther than {config.MAX_STOP_SNAP_METERS} m from a street")
    stops = transit.stops[ok]
    snap_m, snap_node = snap_m[ok], snap_node[ok]
    hops = transit.hops[transit.hops["from_stop"].isin(stops.index) & transit.hops["to_stop"].isin(stops.index)]
    routes = transit.routes.loc[transit.routes.index.isin(hops["route"].unique())]

    n_stop = len(stops)
    stop_idx = {k: n_street + i for i, k in enumerate(stops.index)}
    route_idx = {k: i for i, k in enumerate(routes.index)}

    # Route nodes: one per (route, stop) pair touched by a hop.
    rn_pairs = np.unique(np.concatenate([
        hops[["route", "from_stop"]].to_numpy(),
        hops[["route", "to_stop"]].to_numpy(),
    ]).astype(str), axis=0)
    rn_base = n_street + n_stop
    rn_idx = {(r, s): rn_base + i for i, (r, s) in enumerate(rn_pairs)}
    n_rn = len(rn_pairs)
    n = rn_base + n_rn

    lon = np.concatenate([streets.lon, stops["lon"].to_numpy(),
                          stops.loc[rn_pairs[:, 1], "lon"].to_numpy()]).astype(np.float32)
    lat = np.concatenate([streets.lat, stops["lat"].to_numpy(),
                          stops.loc[rn_pairs[:, 1], "lat"].to_numpy()]).astype(np.float32)
    rn_route = np.array([route_idx[r] for r in rn_pairs[:, 0]], dtype=np.uint16)

    src, dst, w, kind, ride_row = [], [], [], [], []

    def add(s, d, weight, k, rows=None):
        src.append(np.asarray(s, dtype=np.int64))
        dst.append(np.asarray(d, dtype=np.int64))
        w.append(np.asarray(weight, dtype=np.float64))
        kind.append(np.full(len(src[-1]), k, dtype=np.uint8))
        ride_row.append(np.full(len(src[-1]), -1, dtype=np.int64) if rows is None else np.asarray(rows))

    add(streets.edge_u, streets.edge_v, streets.edge_m, WALK)
    add(streets.edge_v, streets.edge_u, streets.edge_m, WALK)
    stop_nodes = np.arange(n_street, n_street + n_stop)
    add(stop_nodes, snap_node, snap_m, WALK)
    add(snap_node, stop_nodes, snap_m, WALK)
    rn_nodes = np.arange(rn_base, n)
    rn_stop = np.array([stop_idx[s] for s in rn_pairs[:, 1]])
    add(rn_stop, rn_nodes, np.zeros(n_rn), BOARD)
    add(rn_nodes, rn_stop, np.zeros(n_rn), ALIGHT)
    add([rn_idx[(r, s)] for r, s in zip(hops["route"], hops["from_stop"])],
        [rn_idx[(r, s)] for r, s in zip(hops["route"], hops["to_stop"])],
        hops["seconds"].to_numpy(), RIDE, rows=np.arange(len(hops)))

    src, dst, w, kind, ride_row = (np.concatenate(a) for a in (src, dst, w, kind, ride_row))
    if w.max() > 65535:
        print(f"  warning: clamping {(w > 65535).sum()} edge weights above 65535")
    order = np.argsort(src, kind="stable")
    src, dst, w, kind, ride_row = src[order], dst[order], w[order], kind[order], ride_row[order]
    offsets = np.zeros(n + 1, dtype=np.uint32)
    offsets[1:] = np.cumsum(np.bincount(src, minlength=n))
    n_edge = len(src)

    # Per-period RIDE weights for route-node edges (contiguous at the end of the CSR).
    rn_rows = ride_row[offsets[rn_base]:]
    is_ride = rn_rows >= 0
    period_w = np.full((len(PERIODS), len(rn_rows)), NO_SERVICE, dtype=np.uint16)
    for p, col in enumerate(PERIOD_COLS):
        secs = hops[col].to_numpy()[rn_rows[is_ride]]
        period_w[p, is_ride] = np.where(np.isnan(secs), NO_SERVICE,
                                        np.clip(np.rint(np.nan_to_num(secs)), 0, NO_SERVICE - 1))
    for (name, _), row in zip(PERIODS, period_w):
        print(f"  period {name}: {(row[is_ride] != NO_SERVICE).sum():,}/{is_ride.sum():,} hops served")

    args.out.mkdir(parents=True, exist_ok=True)
    with open(args.out / "graph.bin", "wb") as f:
        f.write(b"MMG1")
        f.write(struct.pack("<7I", VERSION, n_street, n_stop, n_rn, n_edge, len(PERIODS), 0))
        f.write(lon.tobytes())
        f.write(lat.tobytes())
        f.write(offsets.tobytes())
        f.write(dst.astype(np.uint32).tobytes())
        f.write(np.clip(np.rint(w), 0, 65535).astype(np.uint16).tobytes())
        f.write(rn_route.tobytes())
        f.write(kind.tobytes())
        if f.tell() % 2:
            f.write(b"\0")
        f.write(period_w.tobytes())

    write_shapes(args.out / "shapes.bin", hops, transit.hop_shapes, rn_idx, stops)

    meta = {
        "version": VERSION,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "bbox": [float(lon[:n_street].min()), float(lat[:n_street].min()),
                 float(lon[:n_street].max()), float(lat[:n_street].max())],
        "modeGroups": MODE_GROUPS,
        "periods": [{"id": pid, "label": label} for pid, label in PERIODS],
        "agencies": sorted(routes["agency"].unique().tolist()),
        "routes": [
            {"agency": r.agency, "shortName": r.short_name, "longName": r.long_name,
             "type": int(r.route_type), "group": int(r.group), "color": r.color}
            for r in routes.itertuples()
        ],
        "stops": [{"name": nm} for nm in stops["name"]],
    }
    (args.out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    size_mb = (args.out / "graph.bin").stat().st_size / 1e6
    print(f"Wrote {n:,} nodes ({n_street:,} street, {n_stop:,} stop, {n_rn:,} route), "
          f"{n_edge:,} edges, {size_mb:.1f} MB in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
