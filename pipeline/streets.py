"""OSM -> simplified, undirected walking graph."""

from array import array
from dataclasses import dataclass

import numpy as np
import osmium
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

import config
from geo import haversine_m, points_in_polygon


@dataclass
class StreetGraph:
    lon: np.ndarray  # float64[n]
    lat: np.ndarray
    edge_u: np.ndarray  # int64[m], undirected, u != v
    edge_v: np.ndarray
    edge_m: np.ndarray  # float64[m] meters


def _is_walkable(tags) -> bool:
    hw = tags.get("highway")
    if hw is None or hw in config.WALK_HIGHWAYS_EXCLUDED:
        return False
    foot = tags.get("foot")
    if foot in ("no", "private", "discouraged"):
        return False
    if foot not in ("yes", "designated", "permissive") and tags.get("access") in ("no", "private"):
        return False
    if hw == "service" and tags.get("service") in config.SERVICE_EXCLUDED:
        return False
    if tags.get("footway") in config.FOOTWAY_EXCLUDED:
        return False
    return True


def read_ways(path, bbox):
    """Returns flat arrays of way-node refs with coordinates, plus way offsets."""
    min_lon, min_lat, max_lon, max_lat = bbox
    ids, lons, lats = array("q"), array("d"), array("d")
    offsets = array("q", [0])

    fp = (
        osmium.FileProcessor(str(path))
        .with_locations()
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        .with_filter(osmium.filter.KeyFilter("highway"))
    )
    for way in fp:
        if not _is_walkable(way.tags):
            continue
        nodes = [n for n in way.nodes if n.location.valid()]
        if len(nodes) < 2:
            continue
        first = nodes[0]
        if not (min_lon <= first.lon <= max_lon and min_lat <= first.lat <= max_lat):
            continue
        for n in nodes:
            ids.append(n.ref)
            lons.append(n.lon)
            lats.append(n.lat)
        offsets.append(len(ids))

    return (
        np.frombuffer(ids, dtype=np.int64),
        np.frombuffer(lons, dtype=np.float64),
        np.frombuffer(lats, dtype=np.float64),
        np.frombuffer(offsets, dtype=np.int64),
    )


def build_street_graph(path, bbox) -> StreetGraph:
    ids, lons, lats, offsets = read_ways(path, bbox)
    n_ref = len(ids)
    n_way = len(offsets) - 1
    print(f"  {n_way:,} walkable ways, {n_ref:,} node refs")

    way_of_ref = np.repeat(np.arange(n_way), np.diff(offsets))
    is_way_start = np.zeros(n_ref, dtype=bool)
    is_way_start[offsets[:-1]] = True
    is_way_end = np.zeros(n_ref, dtype=bool)
    is_way_end[offsets[1:] - 1] = True

    # Segment lengths between consecutive refs, zeroed across way boundaries.
    seg = np.zeros(n_ref)
    seg[1:] = haversine_m(lons[:-1], lats[:-1], lons[1:], lats[1:])
    seg[is_way_start] = 0.0
    cum = np.cumsum(seg)

    # Keep: way endpoints, nodes shared between ways (intersections), and a
    # vertex every ~MAX_EDGE_METERS along long stretches.
    uniq, inverse, counts = np.unique(ids, return_inverse=True, return_counts=True)
    keep = is_way_start | is_way_end | (counts[inverse] > 1)
    bucket = np.floor(cum / config.MAX_EDGE_METERS).astype(np.int64)
    keep[1:] |= bucket[1:] != bucket[:-1]

    k = np.flatnonzero(keep)
    same_way = way_of_ref[k[:-1]] == way_of_ref[k[1:]]
    a, b = k[:-1][same_way], k[1:][same_way]
    edge_m = cum[b] - cum[a]

    # Compact node indices over kept refs.
    kept_uniq, node_of_kept = np.unique(inverse[k], return_inverse=True)
    node_of_ref = np.full(n_ref, -1, dtype=np.int64)
    node_of_ref[k] = node_of_kept
    n_nodes = len(kept_uniq)
    node_lon = np.empty(n_nodes)
    node_lat = np.empty(n_nodes)
    node_lon[node_of_ref[k]] = lons[k]
    node_lat[node_of_ref[k]] = lats[k]

    u, v = node_of_ref[a], node_of_ref[b]
    ok = u != v
    u, v, edge_m = u[ok], v[ok], edge_m[ok]

    # Dedupe parallel edges, keeping the shortest.
    lo, hi = np.minimum(u, v), np.maximum(u, v)
    order = np.lexsort((edge_m, hi, lo))
    lo, hi, edge_m = lo[order], hi[order], edge_m[order]
    first = np.ones(len(lo), dtype=bool)
    first[1:] = (lo[1:] != lo[:-1]) | (hi[1:] != hi[:-1])
    u, v, edge_m = lo[first], hi[first], edge_m[first]

    # Keep only nodes inside the Bay Area polygon, in large connected components.
    inside = points_in_polygon(node_lon, node_lat, config.BAY_AREA_POLYGON)
    both_inside = inside[u] & inside[v]
    u, v, edge_m = u[both_inside], v[both_inside], edge_m[both_inside]
    adj = coo_matrix((np.ones(len(u)), (u, v)), shape=(n_nodes, n_nodes))
    _, labels = connected_components(adj, directed=False)
    sizes = np.bincount(labels)
    node_ok = inside & (sizes[labels] >= config.MIN_COMPONENT_NODES)
    remap = np.cumsum(node_ok) - 1
    edge_ok = node_ok[u]
    print(
        f"  {n_nodes:,} nodes before component filter, "
        f"kept {node_ok.sum():,} in {(sizes >= config.MIN_COMPONENT_NODES).sum()} component(s)"
    )

    return StreetGraph(
        lon=node_lon[node_ok],
        lat=node_lat[node_ok],
        edge_u=remap[u[edge_ok]],
        edge_v=remap[v[edge_ok]],
        edge_m=edge_m[edge_ok],
    )
