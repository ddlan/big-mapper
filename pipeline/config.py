"""Pipeline configuration. Edit freely."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
GTFS_DIR = RAW_DIR / "gtfs"
OSM_PATH = RAW_DIR / "norcal-latest.osm.pbf"
OUT_DIR = ROOT / "web" / "public" / "data"

# 511.org regional feed (all Bay Area operators in one zip). Free key: https://511.org/open-data/token
GTFS_511_URL = "http://api.511.org/transit/datafeeds?api_key={key}&operator_id=RG"
OSM_URL = "https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf"

# Coarse outline of the nine Bay Area counties, (lon, lat). Used to
#   1. drop agencies whose stops are mostly outside it, and
#   2. clip remaining agencies' stops (e.g. Capitol Corridor beyond Suisun).
BAY_AREA_POLYGON = [
    (-123.60, 38.78),  # Sonoma coast, Gualala
    (-123.00, 38.87),  # Sonoma / Mendocino
    (-122.62, 38.67),  # Mt St Helena
    (-122.10, 38.70),  # Napa / Yolo
    (-121.95, 38.55),  # Solano / Yolo, west of Davis
    (-121.60, 38.33),  # Putah Creek -> Delta
    (-121.56, 38.10),  # Rio Vista / Delta
    (-121.55, 37.54),  # Alameda / San Joaquin, west of Tracy
    (-121.40, 37.40),
    (-121.21, 36.95),  # Pacheco Pass
    (-121.50, 36.89),  # south of Gilroy
    (-121.85, 37.05),  # Santa Cruz Mtns ridge (Scotts Valley outside)
    (-122.15, 37.25),
    (-122.30, 37.10),  # Año Nuevo
    (-122.60, 37.10),  # offshore
    (-122.75, 37.60),
    (-123.20, 38.00),  # off Point Reyes
    (-123.75, 38.80),
]

# An agency is kept if at least this share of its stops are inside the polygon...
AGENCY_MIN_INSIDE_SHARE = 0.5
# ...unless overridden here. Match on agency_id or agency_name (case-insensitive).
# Run `python build_graph.py --list-agencies` to see what's in the feed.
FORCE_INCLUDE_AGENCIES: list[str] = [
    "SE",  # SolanoExpress: Solano County agency, but most stops are in Sacramento/Davis (clipped)
]
FORCE_EXCLUDE_AGENCIES: list[str] = []

# Street network
WALK_HIGHWAYS_EXCLUDED = {
    "motorway", "motorway_link", "construction", "proposed", "abandoned",
    "bus_guideway", "raceway", "busway", "platform", "elevator",
}
SERVICE_EXCLUDED = {"parking_aisle", "driveway", "drive-through"}
# Separately mapped sidewalks/crossings duplicate the street they run beside and
# roughly double node count without adding reach.
FOOTWAY_EXCLUDED = {"sidewalk", "crossing", "traffic_island"}
# Keep an intermediate vertex roughly every N meters so long roads still get
# travel-time samples along their length (the renderer splats from vertices).
MAX_EDGE_METERS = 200
# Drop disconnected street fragments smaller than this (stops snapping to a
# parking-lot island is a classic bug).
MIN_COMPONENT_NODES = 1000
# Stops farther than this from any street are dropped.
MAX_STOP_SNAP_METERS = 400
