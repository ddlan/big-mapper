"""Extract named places for the daily game: neighbourhoods (puzzle centers) and
the city each one is in (from admin_level=8 boundaries).

  ../.venv/bin/python places.py        # writes web/public/data/places.json
"""

import json
import time

import numpy as np
import osmium

import config
from geo import points_in_polygon

NEIGHBOURHOOD_TYPES = {"neighbourhood", "suburb", "quarter"}
CITY_TYPES = {"city", "town", "village"}


def main():
    t0 = time.time()
    places, cities, counties = [], [], []
    fp = (
        osmium.FileProcessor(str(config.OSM_PATH))
        .with_areas(osmium.filter.TagFilter(("boundary", "administrative")))
        .with_filter(osmium.filter.KeyFilter("place", "boundary"))
    )
    for obj in fp:
        tags = obj.tags
        if obj.is_node() and tags.get("place") in NEIGHBOURHOOD_TYPES | CITY_TYPES and "name" in tags:
            places.append({"name": tags["name"], "type": tags["place"],
                           "lon": round(obj.location.lon, 5), "lat": round(obj.location.lat, 5)})
        elif obj.is_area() and tags.get("boundary") == "administrative" and "name" in tags \
                and tags.get("admin_level") in ("6", "8"):
            rings = [[(n.lon, n.lat) for n in outer] for outer in obj.outer_rings()]
            if rings:
                (cities if tags["admin_level"] == "8" else counties).append((tags["name"], rings))

    lon = np.array([p["lon"] for p in places])
    lat = np.array([p["lat"] for p in places])
    inside = points_in_polygon(lon, lat, config.BAY_AREA_POLYGON)
    places = [p for p, ok in zip(places, inside) if ok]
    lon, lat = lon[inside], lat[inside]

    # Assign each place to the city containing it; fall back to the county for
    # San Francisco (a consolidated city-county) and unincorporated areas.
    def containing(boundaries):
        out = [""] * len(places)
        for name, rings in boundaries:
            hit = np.zeros(len(places), dtype=bool)
            for ring in rings:
                hit |= points_in_polygon(lon, lat, ring)
            for i in np.flatnonzero(hit):
                out[i] = name
        return out

    city_of = [c or k for c, k in zip(containing(cities), containing(counties))]
    for p, c in zip(places, city_of):
        p["city"] = c

    out = config.OUT_DIR / "places.json"
    out.write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")))
    n_hood = sum(p["type"] in NEIGHBOURHOOD_TYPES for p in places)
    print(f"{len(places)} places ({n_hood} neighbourhoods), {len(cities)} city boundaries, "
          f"{sum(1 for c in city_of if c)} assigned a city -> {out} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
