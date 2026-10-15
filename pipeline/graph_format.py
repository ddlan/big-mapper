"""Compact graph encoding (graph.bin.gz, format v3).

Only what the browser can't derive is stored; it rebuilds the full CSR graph
(both edge directions, BOARD/ALIGHT edges, edge kinds, offsets) on load.

Node order: streets [0, S), stops [S, S+P), route nodes [S+P, N). Streets and
stops are each sorted along a Hilbert curve, so map neighbours get nearby ids
and edge targets compress to small deltas. Route nodes are sorted by
(stop, route), and their coordinates are their stop's.

File = gzip of:
  header 8 x u32: magic "MMG1", version 3, nStreet, nStop, nRouteNode, nWalk, nRide, nPeriod
  13 streams, each u32 byte length + LEB128 varints (zz = zigzag-signed):
    1  lon delta (zz, 1e-6 deg) for streets then stops
    2  lat delta (zz, 1e-6 deg)
    3  per street: number of walk edges to higher-id streets
    4  per walk edge: target - previous target (first: target - source), > 0
    5  per walk edge: meters
    6  per stop: snapped street id delta (zz, vs previous stop's)
    7  per stop: snap meters
    8  per route node: stop index delta (stops are non-decreasing)
    9  per route node: route index
    10 per route node: number of RIDE edges
    11 per ride: target route node - source route node (zz)
    12 per ride: seconds (any time)
    13 per ride, per period: seconds + 1, or 0 if no service in that period
"""

import gzip
import struct

import numpy as np

VERSION = 3
NO_SERVICE = 65535


def hilbert_order(lon, lat, bits: int = 16) -> np.ndarray:
    """Argsort of points along a Hilbert curve over their bounding box."""
    lon, lat = np.asarray(lon, np.float64), np.asarray(lat, np.float64)
    n = 1 << bits

    def scale(v):
        lo, hi = v.min(), v.max()
        return np.clip(((v - lo) / max(hi - lo, 1e-12) * (n - 1)).astype(np.int64), 0, n - 1)

    x, y = scale(lon), scale(lat)
    d = np.zeros(len(x), np.int64)
    s = n >> 1
    while s > 0:
        rx = (x & s) > 0
        ry = (y & s) > 0
        d += s * s * ((3 * rx) ^ ry)
        # Rotate the quadrant.
        flip = ~ry & rx
        x = np.where(flip, n - 1 - x, x)
        y = np.where(flip, n - 1 - y, y)
        swap = ~ry
        x, y = np.where(swap, y, x), np.where(swap, x, y)
        s >>= 1
    return np.argsort(d, kind="stable")


def zigzag(a) -> np.ndarray:
    a = np.asarray(a, np.int64)
    return ((a << 1) ^ (a >> 63)).astype(np.uint64)


def varints(a) -> bytes:
    """Vectorized unsigned LEB128."""
    v = np.asarray(a, np.uint64).copy()
    if v.size == 0:
        return b""
    nbytes = np.ones(v.size, np.int64)
    t = v >> np.uint64(7)
    while t.any():
        nbytes += t > 0
        t >>= np.uint64(7)
    starts = np.cumsum(nbytes) - nbytes
    out = np.empty(int(nbytes.sum()), np.uint8)
    for i in range(int(nbytes.max())):
        m = nbytes > i
        byte = (v[m] & np.uint64(0x7F)).astype(np.uint8)
        byte |= ((nbytes[m] > i + 1).astype(np.uint8) << 7)
        out[starts[m] + i] = byte
        v[m] >>= np.uint64(7)
    return out.tobytes()


def write_graph(path, *, street_lon, street_lat, stop_lon, stop_lat,
                walk_u, walk_v, walk_m, snap_street, snap_m,
                rn_stop, rn_route, ride_from, ride_to, ride_s, ride_period_s):
    """
    All ids are local to their kind: walk_u/v and snap_street index streets,
    rn_stop indexes stops, ride_from/to index route nodes. rn_stop must be
    non-decreasing. ride_period_s: (nRide, nPeriod) seconds with NaN = no service.
    """
    n_street, n_stop, n_rn = len(street_lon), len(stop_lon), len(rn_stop)

    # Coordinates as 1e-6 degree integers, delta-coded in id order.
    q = lambda a: np.rint(np.asarray(a, np.float64) * 1e6).astype(np.int64)  # noqa: E731
    lon_q = q(np.concatenate([street_lon, stop_lon]))
    lat_q = q(np.concatenate([street_lat, stop_lat]))

    # Walk edges once, from the lower id; per source, targets ascending.
    lo, hi = np.minimum(walk_u, walk_v), np.maximum(walk_u, walk_v)
    order = np.lexsort((hi, lo))
    lo, hi, wm = lo[order], hi[order], np.asarray(walk_m)[order]
    up_deg = np.bincount(lo, minlength=n_street)
    prev = np.empty(len(lo), np.int64)
    prev[:] = lo
    same = np.zeros(len(lo), bool)
    same[1:] = lo[1:] == lo[:-1]
    prev[1:][same[1:]] = hi[:-1][same[1:]]
    walk_delta = hi - prev

    snap_street = np.asarray(snap_street, np.int64)
    snap_delta = np.diff(snap_street, prepend=0)

    rn_stop = np.asarray(rn_stop, np.int64)
    assert np.all(np.diff(rn_stop) >= 0), "route nodes must be sorted by stop"
    ride_from, ride_to = np.asarray(ride_from, np.int64), np.asarray(ride_to, np.int64)
    order = np.argsort(ride_from, kind="stable")
    ride_from, ride_to = ride_from[order], ride_to[order]
    ride_s = np.asarray(ride_s)[order]
    ride_period_s = np.asarray(ride_period_s, np.float64)[order]
    ride_deg = np.bincount(ride_from, minlength=n_rn)
    period_vals = np.where(np.isnan(ride_period_s), 0,
                           np.clip(np.rint(np.nan_to_num(ride_period_s)), 0, NO_SERVICE - 1) + 1)

    clip16 = lambda a: np.clip(np.rint(np.asarray(a, np.float64)), 0, NO_SERVICE - 1).astype(np.int64)  # noqa: E731
    streams = [
        zigzag(np.diff(lon_q, prepend=0)),
        zigzag(np.diff(lat_q, prepend=0)),
        up_deg,
        walk_delta,
        clip16(wm),
        zigzag(snap_delta),
        clip16(snap_m),
        np.diff(rn_stop, prepend=0),
        rn_route,
        ride_deg,
        zigzag(ride_to - ride_from),
        clip16(ride_s),
        period_vals.reshape(-1),
    ]
    n_period = ride_period_s.shape[1] if ride_period_s.ndim == 2 else 0

    body = [b"MMG1", struct.pack("<7I", VERSION, n_street, n_stop, n_rn, len(lo), len(ride_from), n_period)]
    for s in streams:
        enc = varints(np.asarray(s, np.uint64))
        body += [struct.pack("<I", len(enc)), enc]
    raw = b"".join(body)
    with open(path, "wb") as f:
        f.write(gzip.compress(raw, compresslevel=9, mtime=0))
    return len(raw)
