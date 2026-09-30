"""Download raw inputs into data/raw/.

  API_511_KEY=... python download.py          # 511 regional GTFS + Geofabrik NorCal OSM (~600 MB)
  python download.py --skip-osm               # GTFS only
"""

import argparse
import os
import shutil
import sys
import urllib.request

import config


def fetch(url: str, dest, label: str):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"Downloading {label} -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "big-mapper/0.1"})
    with urllib.request.urlopen(req) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:,.0f} / {total / 1e6:,.0f} MB", end="", flush=True)
        print()
    shutil.move(tmp, dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-gtfs", action="store_true")
    ap.add_argument("--skip-osm", action="store_true")
    args = ap.parse_args()

    if not args.skip_gtfs:
        key = os.environ.get("API_511_KEY")
        if not key:
            sys.exit("Set API_511_KEY (free at https://511.org/open-data/token), or pass --skip-gtfs "
                     f"and drop your own GTFS zips into {config.GTFS_DIR}")
        fetch(config.GTFS_511_URL.format(key=key), config.GTFS_DIR / "511_regional.zip", "511 regional GTFS")

    if not args.skip_osm:
        fetch(config.OSM_URL, config.OSM_PATH, "Geofabrik NorCal OSM extract")


if __name__ == "__main__":
    main()
