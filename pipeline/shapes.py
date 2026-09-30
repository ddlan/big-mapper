"""Cut GTFS shapes into per-hop polylines (stop -> next stop on a route)."""

import numpy as np
import pandas as pd

from geo import project_local_m

# When choosing where a stop falls along a shape, take the earliest segment
# within this many meters of the closest one. Keeps loop routes (which pass
# the same street twice) from jumping ahead.
SNAP_SLACK_M = 30.0
SIMPLIFY_M = 3.0


def _simplify(xy: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker; returns a boolean keep-mask."""
    keep = np.zeros(len(xy), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = xy[b] - xy[a]
        pts = xy[a + 1:b] - xy[a]
        L = np.hypot(*seg)
        d = np.abs(seg[0] * pts[:, 1] - seg[1] * pts[:, 0]) / L if L > 0 else np.hypot(pts[:, 0], pts[:, 1])
        i = int(np.argmax(d))
        if d[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return keep


def _locate_stops(shape_xy: np.ndarray, stops_xy: np.ndarray):
    """Monotonic projection of stops onto a polyline. Returns (segment index, t) per stop."""
    A = shape_xy[:-1]
    D = shape_xy[1:] - A
    len2 = np.maximum((D ** 2).sum(axis=1), 1e-9)
    out_seg = np.empty(len(stops_xy), dtype=np.int64)
    out_t = np.empty(len(stops_xy))
    cur_seg, cur_t = 0, 0.0
    for i, s in enumerate(stops_xy):
        a, d, l2 = A[cur_seg:], D[cur_seg:], len2[cur_seg:]
        t = np.clip(((s - a) * d).sum(axis=1) / l2, 0.0, 1.0)
        t[0] = max(t[0], cur_t)
        dist = np.hypot(*(a + t[:, None] * d - s).T)
        j = int(np.flatnonzero(dist <= dist.min() + SNAP_SLACK_M)[0])
        cur_seg, cur_t = cur_seg + j, float(t[j])
        out_seg[i], out_t[i] = cur_seg, cur_t
    return out_seg, out_t


def hop_geometries(st: pd.DataFrame, trips: pd.DataFrame, stops: pd.DataFrame, shapes: pd.DataFrame | None):
    """
    st: stop_times sorted by (trip_id, stop_sequence), columns trip_id, stop_id
    trips: route_id, trip_id, shape_id
    stops: indexed by raw stop_id with lon, lat
    Returns {(route_id, from_stop, to_stop): float32 array [[lon, lat], ...]} using raw ids.
    """
    if shapes is None or "shape_id" not in trips or trips["shape_id"].isna().all():
        return {}

    shapes = shapes.assign(
        seq=pd.to_numeric(shapes["shape_pt_sequence"]),
        lon=pd.to_numeric(shapes["shape_pt_lon"]),
        lat=pd.to_numeric(shapes["shape_pt_lat"]),
    ).sort_values(["shape_id", "seq"])
    shape_pts = {sid: g[["lon", "lat"]].to_numpy() for sid, g in shapes.groupby("shape_id", sort=False)}

    pattern = st.groupby("trip_id", sort=False)["stop_id"].agg("\x1f".join).rename("pattern")
    pats = trips.dropna(subset=["shape_id"]).join(pattern, on="trip_id", how="inner")
    pats = pats.drop_duplicates(["route_id", "shape_id", "pattern"])

    lonlat = stops[["lon", "lat"]]
    out: dict[tuple[str, str, str], np.ndarray] = {}
    for route_id, shape_id, pat in pats[["route_id", "shape_id", "pattern"]].itertuples(index=False):
        pts = shape_pts.get(shape_id)
        stop_ids = pat.split("\x1f")
        if pts is None or len(pts) < 2 or len(stop_ids) < 2:
            continue
        hops = [(a, b) for a, b in zip(stop_ids, stop_ids[1:]) if a != b and (route_id, a, b) not in out]
        if not hops:
            continue
        try:
            sll = lonlat.loc[stop_ids].to_numpy()
        except KeyError:
            continue
        lat0 = float(pts[:, 1].mean())
        shape_xy = project_local_m(pts[:, 0], pts[:, 1], lat0)
        seg, _ = _locate_stops(shape_xy, project_local_m(sll[:, 0], sll[:, 1], lat0))
        for i in range(len(stop_ids) - 1):
            key = (route_id, stop_ids[i], stop_ids[i + 1])
            if key[1] == key[2] or key in out:
                continue
            a, b = seg[i], seg[i + 1]
            if b < a:
                continue
            line = np.vstack([sll[i], pts[a + 1:b + 1], sll[i + 1]])
            xy = project_local_m(line[:, 0], line[:, 1], lat0)
            out[key] = line[_simplify(xy, SIMPLIFY_M)].astype(np.float32)
    return out
