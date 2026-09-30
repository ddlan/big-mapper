"""GTFS -> time-independent ("optimistic") transit hops.

Every schedule detail except the fastest in-vehicle time between consecutive
stops is discarded: no waiting, no frequencies, no time of day.
"""

import io
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

import config
from geo import points_in_polygon
from shapes import hop_geometries

# Mode groups exposed as toggles in the UI.
MODE_GROUPS = ["bus", "rail", "light rail / streetcar / cable car", "ferry"]

# Coarse service periods. A hop is available in a period if any trip serves it
# then; its time is the fastest such trip. Hours are trip departure hours at the
# hop (GTFS times past 24:00 count as late night).
PERIODS = [
    ("rush", "Weekday rush hour"),     # Mon-Fri 7-10, 16-19
    ("midday", "Weekday midday"),      # Mon-Fri 10-16
    ("evening", "Weekday evening"),    # Mon-Fri 19-24
    ("weekend", "Weekend daytime"),    # Sat/Sun 8-20
    ("night", "Late night"),           # any day 0-5
]
PERIOD_COLS = [f"s_{p}" for p, _ in PERIODS]


def _period_masks(hour, weekday, weekend):
    late = (hour < 5) | (hour >= 24)
    return {
        "rush": weekday & (((hour >= 7) & (hour < 10)) | ((hour >= 16) & (hour < 19))),
        "midday": weekday & (hour >= 10) & (hour < 16),
        "evening": weekday & (hour >= 19) & (hour < 24),
        "weekend": weekend & (hour >= 8) & (hour < 20),
        "night": late,
    }


def _service_day_types(cal: pd.DataFrame | None, cal_dates: pd.DataFrame | None):
    """service_id sets running on weekdays / weekends (date ranges and holiday removals ignored)."""
    weekday, weekend = set(), set()
    if cal is not None and len(cal):
        wd = cal[["monday", "tuesday", "wednesday", "thursday", "friday"]].astype(int).sum(axis=1) > 0
        we = cal[["saturday", "sunday"]].astype(int).sum(axis=1) > 0
        weekday |= set(cal.loc[wd, "service_id"])
        weekend |= set(cal.loc[we, "service_id"])
    if cal_dates is not None and len(cal_dates):
        added = cal_dates[cal_dates["exception_type"].astype(int) == 1]
        dow = pd.to_datetime(added["date"], format="%Y%m%d").dt.dayofweek
        weekday |= set(added.loc[dow < 5, "service_id"])
        weekend |= set(added.loc[dow >= 5, "service_id"])
    return weekday, weekend


def mode_group(route_type: int) -> int:
    t = int(route_type)
    if t in (1, 2, 12) or 100 <= t < 200 or 400 <= t < 500:
        return 1
    if t in (0, 5, 6, 7) or 900 <= t < 1000 or 1300 <= t < 1500:
        return 2
    if t == 4 or 1000 <= t < 1100 or 1200 <= t < 1300:
        return 3
    return 0  # 3, 11, 700-899, and anything unknown


@dataclass
class TransitData:
    stops: pd.DataFrame  # index: stop key; columns: lon, lat, name
    routes: pd.DataFrame  # index: route key; columns: agency, short_name, long_name, route_type, group, color
    hops: pd.DataFrame  # columns: route, from_stop, to_stop, seconds (any time), s_<period> (NaN = no service)
    hop_shapes: dict  # (route, from_stop, to_stop) -> float32 [[lon, lat], ...]
    agency_report: pd.DataFrame


def _read(zf: zipfile.ZipFile, name: str, usecols=None) -> pd.DataFrame | None:
    matches = [n for n in zf.namelist() if n.split("/")[-1] == name]
    if not matches:
        return None
    with zf.open(matches[0]) as f:
        df = pd.read_csv(io.TextIOWrapper(f, encoding="utf-8-sig"), dtype=str, usecols=usecols,
                         skipinitialspace=True, keep_default_na=False, na_values=[""])
    df.columns = [c.strip() for c in df.columns]
    return df


def _parse_gtfs_time(s: pd.Series) -> pd.Series:
    parts = s.str.strip().str.split(":", expand=True)
    if parts.shape[1] < 3:
        return pd.Series(np.nan, index=s.index)
    h, m, sec = (pd.to_numeric(parts[i], errors="coerce") for i in range(3))
    return h * 3600 + m * 60 + sec


def _load_feed(path: Path):
    prefix = path.stem
    key = lambda s: prefix + ":" + s  # noqa: E731  feeds may reuse ids
    with zipfile.ZipFile(path) as zf:
        agency = _read(zf, "agency.txt")
        routes = _read(zf, "routes.txt")
        trips = _read(zf, "trips.txt",
                      usecols=lambda c: c.strip() in ("route_id", "trip_id", "shape_id", "service_id"))
        cal = _read(zf, "calendar.txt")
        cal_dates = _read(zf, "calendar_dates.txt")
        shapes = _read(zf, "shapes.txt")
        stops = _read(zf, "stops.txt")
        st = _read(zf, "stop_times.txt",
                   usecols=["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"])

    default_agency = agency["agency_id"].iloc[0] if "agency_id" in agency and agency["agency_id"].notna().any() \
        else agency["agency_name"].iloc[0]
    if "agency_id" not in agency:
        agency["agency_id"] = default_agency
    agency["agency_id"] = agency["agency_id"].fillna(default_agency)
    if "agency_id" not in routes:
        routes["agency_id"] = default_agency
    routes["agency_id"] = routes["agency_id"].fillna(default_agency)
    agency_name = dict(zip(agency["agency_id"], agency["agency_name"]))

    routes_out = pd.DataFrame({
        "agency_id": routes["agency_id"].values,
        "agency": routes["agency_id"].map(agency_name).fillna(routes["agency_id"]).values,
        "short_name": routes.get("route_short_name", pd.Series("", index=routes.index)).fillna("").values,
        "long_name": routes.get("route_long_name", pd.Series("", index=routes.index)).fillna("").values,
        "route_type": routes["route_type"].astype(int).values,
        "color": routes.get("route_color", pd.Series("", index=routes.index)).fillna("").values,
    }, index=routes["route_id"].map(key).values)
    routes_out["group"] = routes_out["route_type"].map(mode_group)

    stops_out = pd.DataFrame({
        "lon": pd.to_numeric(stops["stop_lon"], errors="coerce").values,
        "lat": pd.to_numeric(stops["stop_lat"], errors="coerce").values,
        "name": stops.get("stop_name", pd.Series("", index=stops.index)).fillna("").values,
    }, index=stops["stop_id"].map(key).values)

    st["stop_sequence"] = pd.to_numeric(st["stop_sequence"])
    st = st.sort_values(["trip_id", "stop_sequence"], kind="stable").reset_index(drop=True)
    arr = _parse_gtfs_time(st["arrival_time"].fillna(""))
    dep = _parse_gtfs_time(st["departure_time"].fillna(""))
    arr, dep = arr.fillna(dep), dep.fillna(arr)
    # Non-timepoint stops may be blank. Every trip's first/last stop must be
    # timed, so a global row-order interpolation never crosses trips.
    arr, dep = arr.interpolate(), dep.interpolate()

    same_trip = st["trip_id"].values[:-1] == st["trip_id"].values[1:]
    idx = np.flatnonzero(same_trip)
    hops = pd.DataFrame({
        "trip_id": st["trip_id"].values[idx],
        "from_stop": st["stop_id"].values[idx],
        "to_stop": st["stop_id"].values[idx + 1],
        "seconds": np.clip(arr.values[idx + 1] - dep.values[idx], 0, None),
        "hour": dep.values[idx] // 3600,
    })
    hops = hops[hops["from_stop"] != hops["to_stop"]].dropna(subset=["seconds"])
    hops = hops.merge(trips[["route_id", "trip_id", "service_id"]], on="trip_id")
    weekday_svc, weekend_svc = _service_day_types(cal, cal_dates)
    masks = _period_masks(hops["hour"], hops["service_id"].isin(weekday_svc), hops["service_id"].isin(weekend_svc))
    for (name, _), col in zip(PERIODS, PERIOD_COLS):
        hops[col] = hops["seconds"].where(masks[name])
    hops = hops.groupby(["route_id", "from_stop", "to_stop"], as_index=False)[["seconds", *PERIOD_COLS]].min()
    hops["route"] = hops["route_id"].map(key)
    hops["from_stop"] = hops["from_stop"].map(key)
    hops["to_stop"] = hops["to_stop"].map(key)

    raw_stops = stops_out.set_axis(stops["stop_id"].values)
    geoms = hop_geometries(st[["trip_id", "stop_id"]], trips, raw_stops, shapes)
    hop_shapes = {(key(r), key(a), key(b)): g for (r, a, b), g in geoms.items()}
    print(f"  {path.name}: {len(hops):,} hops, {len(hop_shapes):,} with shape geometry")
    return stops_out, routes_out, hops[["route", "from_stop", "to_stop", "seconds", *PERIOD_COLS]], hop_shapes


def _matches(row, names) -> bool:
    lowered = {n.lower() for n in names}
    return row["agency_id"].lower() in lowered or row["agency"].lower() in lowered


def load_transit(gtfs_paths: list[Path]) -> TransitData:
    feeds = [_load_feed(p) for p in gtfs_paths]
    stops = pd.concat([f[0] for f in feeds])
    stops = stops[~stops.index.duplicated()]
    routes = pd.concat([f[1] for f in feeds])
    hops = pd.concat([f[2] for f in feeds], ignore_index=True)
    hop_shapes = {k: v for f in feeds for k, v in f[3].items()}

    stops = stops.dropna(subset=["lon", "lat"])
    stops["inside"] = points_in_polygon(stops["lon"], stops["lat"], config.BAY_AREA_POLYGON)
    hops = hops[hops["from_stop"].isin(stops.index) & hops["to_stop"].isin(stops.index)]

    # Agency decision: share of served stops inside the Bay Area polygon.
    hop_agency = hops["route"].map(routes["agency_id"])
    served = pd.concat([
        pd.DataFrame({"agency_id": hop_agency, "stop": hops["from_stop"]}),
        pd.DataFrame({"agency_id": hop_agency, "stop": hops["to_stop"]}),
    ]).drop_duplicates()
    served["inside"] = served["stop"].map(stops["inside"])
    report = served.groupby("agency_id").agg(stops=("stop", "size"), inside_share=("inside", "mean"))
    report["agency"] = routes.drop_duplicates("agency_id").set_index("agency_id")["agency"]
    report = report.reset_index()

    def decide(row):
        if _matches(row, config.FORCE_EXCLUDE_AGENCIES):
            return "excluded (forced)"
        if _matches(row, config.FORCE_INCLUDE_AGENCIES):
            return "included (forced)"
        return "included" if row["inside_share"] >= config.AGENCY_MIN_INSIDE_SHARE else "excluded (outside Bay Area)"

    report["decision"] = report.apply(decide, axis=1)
    kept_agencies = set(report.loc[report["decision"].str.startswith("included"), "agency_id"])

    hops = hops[hop_agency.loc[hops.index].isin(kept_agencies)]
    inside = stops["inside"]
    hops = hops[hops["from_stop"].map(inside) & hops["to_stop"].map(inside)]

    used_stops = pd.unique(np.concatenate([hops["from_stop"].values, hops["to_stop"].values]))
    used_routes = pd.unique(hops["route"].values)
    return TransitData(
        stops=stops.loc[used_stops, ["lon", "lat", "name"]],
        routes=routes.loc[used_routes],
        hops=hops.reset_index(drop=True),
        hop_shapes=hop_shapes,
        agency_report=report.sort_values("stops", ascending=False),
    )
