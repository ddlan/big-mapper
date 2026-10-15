"""Build web/public/data/graph.bin.gz + meta.json from GTFS zips and an OSM extract.

Graph model (all edges time-independent):

  street node  <-WALK(m)->  street node
  street node  <-WALK(m)->  stop node         (stop snapped to nearest street node)
  stop node    --BOARD-->   route node        (one route node per (route, stop))
  route node   --RIDE(s)--> route node        (fastest scheduled hop on that route, per service period)
  route node   --ALIGHT-->  stop node

Walking weights are stored in meters so walk speed is a runtime parameter.
BOARD carries no weight; the router applies the initial-wait / transfer
penalties there. RIDE edges also carry per-period times (meta.periods).

The compact on-disk format (graph.bin.gz) is documented in graph_format.py.

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
from graph_format import VERSION, hilbert_order, write_graph
from transit import MODE_GROUPS, PERIOD_COLS, PERIODS, load_transit




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

    # Hilbert-order streets so map neighbours get nearby ids (small, compressible edge deltas).
    order = hilbert_order(streets.lon, streets.lat)
    new_id = np.empty(n_street, np.int64)
    new_id[order] = np.arange(n_street)
    streets.lon, streets.lat = streets.lon[order], streets.lat[order]
    streets.edge_u, streets.edge_v = new_id[streets.edge_u], new_id[streets.edge_v]

    # Snap stops to nearest street node.
    lat0 = float(np.mean(streets.lat))
    tree = cKDTree(project_local_m(streets.lon, streets.lat, lat0))
    snap_m, snap_node = tree.query(project_local_m(transit.stops["lon"], transit.stops["lat"], lat0))
    ok = snap_m <= config.MAX_STOP_SNAP_METERS
    if (~ok).any():
        print(f"  dropping {(~ok).sum()} stops farther than {config.MAX_STOP_SNAP_METERS} m from a street")
    stops = transit.stops[ok]
    snap_m, snap_node = snap_m[ok], snap_node[ok]
    stop_order = hilbert_order(stops["lon"], stops["lat"])
    stops = stops.iloc[stop_order]
    snap_m, snap_node = snap_m[stop_order], snap_node[stop_order]
    hops = transit.hops[transit.hops["from_stop"].isin(stops.index) & transit.hops["to_stop"].isin(stops.index)]
    routes = transit.routes.loc[transit.routes.index.isin(hops["route"].unique())]

    n_stop = len(stops)
    stop_idx = {k: n_street + i for i, k in enumerate(stops.index)}
    route_idx = {k: i for i, k in enumerate(routes.index)}

    # Route nodes: one per (route, stop) pair touched by a hop, ordered by stop.
    rn_pairs = np.unique(np.concatenate([
        hops[["route", "from_stop"]].to_numpy(),
        hops[["route", "to_stop"]].to_numpy(),
    ]).astype(str), axis=0)
    rn_pairs = rn_pairs[np.lexsort((
        [route_idx[r] for r in rn_pairs[:, 0]],
        [stop_idx[st] for st in rn_pairs[:, 1]],
    ))]
    rn_base = n_street + n_stop
    rn_idx = {(r, s): rn_base + i for i, (r, s) in enumerate(rn_pairs)}
    n_rn = len(rn_pairs)
    n = rn_base + n_rn

    rn_route = np.array([route_idx[r] for r in rn_pairs[:, 0]], dtype=np.int64)
    rn_stop = np.array([stop_idx[st] - n_street for st in rn_pairs[:, 1]], dtype=np.int64)
    ride_from = np.array([rn_idx[(r, st)] - rn_base for r, st in zip(hops["route"], hops["from_stop"])])
    ride_to = np.array([rn_idx[(r, st)] - rn_base for r, st in zip(hops["route"], hops["to_stop"])])
    if hops["seconds"].max() > 65534:
        print(f"  warning: clamping {(hops['seconds'] > 65534).sum()} ride times above 65534 s")
    period_s = hops[PERIOD_COLS].to_numpy(dtype=np.float64)
    for (name, _), col in zip(PERIODS, period_s.T):
        print(f"  period {name}: {(~np.isnan(col)).sum():,}/{len(col):,} hops served")

    args.out.mkdir(parents=True, exist_ok=True)
    stale = args.out / "graph.bin"  # pre-v3 uncompressed graph
    if stale.exists():
        stale.unlink()
    raw_bytes = write_graph(
        args.out / "graph.bin.gz",
        street_lon=streets.lon, street_lat=streets.lat,
        stop_lon=stops["lon"].to_numpy(), stop_lat=stops["lat"].to_numpy(),
        walk_u=streets.edge_u, walk_v=streets.edge_v, walk_m=streets.edge_m,
        snap_street=snap_node, snap_m=snap_m,
        rn_stop=rn_stop, rn_route=rn_route,
        ride_from=ride_from, ride_to=ride_to, ride_s=hops["seconds"].to_numpy(), ride_period_s=period_s,
    )
    n_edge = 2 * len(streets.edge_u) + 2 * n_stop + 2 * n_rn + len(hops)

    write_shapes(args.out / "shapes.bin", hops, transit.hop_shapes, rn_idx, stops)

    meta = {
        "version": VERSION,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "bbox": [float(streets.lon.min()), float(streets.lat.min()),
                 float(streets.lon.max()), float(streets.lat.max())],
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

    size_mb = (args.out / "graph.bin.gz").stat().st_size / 1e6
    print(f"Wrote {n:,} nodes ({n_street:,} street, {n_stop:,} stop, {n_rn:,} route), "
          f"{n_edge:,} edges: {raw_bytes / 1e6:.1f} MB encoded, {size_mb:.1f} MB gzipped, in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
