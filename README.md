# Big Mapper

How far can Bay Area transit take you? Click a point and see travel times as colored bands, like
[commutometer](https://www.commutometer.com/how-its-made.html), with a few deliberate differences:

- **No exact time of day.** Schedules are reduced to the fastest scheduled time between consecutive
  stops, and boarding is instant. Optimistic by design. A coarse "When" selector (weekday rush hour,
  midday, evening, weekend daytime, late night, any time) only counts trips running in that period,
  so owl routes like the 90 don't appear on daytime maps. Periods are defined in `pipeline/transit.py`.
- **Flexible limit.** 15 min to 3 h.
- **Transfer penalty.** Each boarding after the first adds N minutes (slider, default 5). An optional
  "wait for first vehicle" penalty applies to the first boarding (default 0).
- **Bay Area agencies only.** Agencies whose stops are mostly outside the nine counties are dropped,
  and stops outside them are clipped (e.g. Capitol Corridor beyond Suisun). See `pipeline/config.py`.

Everything runs in the browser: the pipeline produces one static graph file, and a Web Worker runs
Dijkstra over it on each click.

## Layout

```
pipeline/            Python: GTFS + OSM -> web/public/data/{graph.bin,meta.json,shapes.bin}
  config.py          Bay Area polygon, agency overrides, street filters
  download.py        fetch 511 regional GTFS + Geofabrik NorCal OSM
  transit.py         GTFS -> fastest hop per (route, stop, next stop)
  shapes.py          GTFS shapes.txt -> per-hop polylines for drawing routes
  streets.py         OSM -> simplified walking graph
  build_graph.py     assemble, snap stops to streets, write binary (format documented inside)
web/                 Vite + TypeScript + MapLibre
  src/router.ts      Dijkstra (with transfer-penalty state) + rasterization
  src/router.worker.ts
  src/main.ts        map, controls, rendering
```

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
cd web && npm install
```

## Build the data

Get a free 511 API key at https://511.org/open-data/token, then:

```bash
cd pipeline
API_511_KEY=yourkey ../.venv/bin/python download.py   # ~600 MB OSM download
../.venv/bin/python build_graph.py --list-agencies     # review include/exclude decisions
../.venv/bin/python build_graph.py
cd ../web && npm run score-dist                        # reference distribution for Score mode (~3 min)
```

You can also drop any GTFS zips into `data/raw/gtfs/` or pass `--gtfs a.zip b.zip` and `--osm file.osm.pbf`.

## Run

```bash
cd web && npm run dev
```

## Using it

The URL holds the state (`?from=lat,lon&to=lat,lon&when=period`), so links are shareable.
Drag the black pin to set the origin. Click anywhere to set a destination: the route is drawn on
the map (transit legs follow GTFS shapes) with an itinerary in the side panel. "Set as start"
moves the origin there.

## Score mode

The Score tab rates the pin's connectivity: km² reachable in 45 min under fixed settings (weekday
rush, 5 min transfer penalty, no initial wait, 5 km/h, all modes; see `web/src/score.ts`), plus a
percentile versus 2,000 randomly sampled street locations (`web/scripts/score-distribution.ts`,
output `public/data/score-dist.json`). Rerun `npm run score-dist` after rebuilding the graph.

## How routing works

Graph nodes are street intersections, stops, and one "route node" per (route, stop). Edges:
WALK (meters, so walk speed is a runtime parameter), BOARD (stop -> route node), RIDE (fastest
scheduled hop), ALIGHT. Dijkstra runs over a doubled state space (not yet boarded / boarded) so the
first boarding and later transfers can be charged differently. Penalties count toward the displayed
time.

The router keeps a predecessor per state, so the path to any clicked destination is traced back
from the last search without re-running it.

Reached nodes are splatted onto a ~40 m Web Mercator grid (walking outward up to 250 m), colored
into bands, and drawn as a MapLibre image layer.
