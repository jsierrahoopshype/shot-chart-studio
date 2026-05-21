"""Build per-player shot aggregates for Shot Range Finder.

Reads merged/shotdetail.parquet from cdechoch/nba-data-archive on
HuggingFace and produces a single small CSV with one row per
(player_id, season, season_type, zone) combination. Bins distances
into common ranges so distance-based queries work without joining
back to the raw shot stream.

Output: dist/shot-chart-shards/aggregates.csv (and .csv.gz)

Rows are ~200K-500K. Compressed CSV is typically 2-4 MB.

CSV columns:
  player_id    int
  name         str
  season       int   (start year, e.g. 2024 = 2024-25)
  season_type  str   (rg or po)
  zone         str   (SHOT_ZONE_BASIC; e.g. "Above the Break 3")
  dist_bucket  str   (one of: "0-3", "3-10", "10-16", "16-22", "22-25", "25+", "backcourt")
  made         int
  attempts     int

Run: python scripts/build_shot_aggregates.py
"""

from __future__ import annotations

import csv
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download
from tqdm import tqdm

REPO_ID = "cdechoch/nba-data-archive"
REPO_TYPE = "dataset"
PARQUET_PATH_IN_REPO = "merged/shotdetail.parquet"

NEEDED_COLUMNS = [
    "PLAYER_ID",
    "SHOT_ZONE_BASIC",
    "SHOT_DISTANCE",
    "SHOT_MADE_FLAG",
    "SHOT_TYPE",
    "_season",
    "_season_type",
]

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"
SHARDS_ROOT = DIST_DIR / "shot-chart-shards"
PLAYERS_CATALOG = ROOT / "data" / "players.json"

OUT_CSV = SHARDS_ROOT / "aggregates.csv"
OUT_CSV_GZ = SHARDS_ROOT / "aggregates.csv.gz"


def dist_bucket(d):
    """Bin SHOT_DISTANCE into a few categories the UI can filter on.

    The 22-25 range straddles the 3PT line in most years; we keep it as
    its own bucket so a 'long mid-range' query (16-22) doesn't accidentally
    include short corner threes.
    """
    if d is None:
        return ""
    try:
        d = int(d)
    except (TypeError, ValueError):
        return ""
    if d > 47:
        return "backcourt"
    if d < 3:
        return "0-3"
    if d < 10:
        return "3-10"
    if d < 16:
        return "10-16"
    if d < 22:
        return "16-22"
    if d < 25:
        return "22-25"
    return "25+"


def main() -> int:
    if not PLAYERS_CATALOG.exists():
        print(
            f"ERROR: {PLAYERS_CATALOG} missing. Run build_player_catalog.py first.",
            file=sys.stderr,
        )
        return 1

    SHARDS_ROOT.mkdir(parents=True, exist_ok=True)

    with PLAYERS_CATALOG.open(encoding="utf-8") as f:
        catalog = json.load(f)
    name_by_pid = {int(pid): p["name"] for pid, p in catalog.items()}

    print(f"Downloading {PARQUET_PATH_IN_REPO} from {REPO_ID}...")
    parquet_path = hf_hub_download(
        repo_id=REPO_ID,
        repo_type=REPO_TYPE,
        filename=PARQUET_PATH_IN_REPO,
    )

    pf = pq.ParquetFile(parquet_path)
    print(f"Parquet rows: {pf.metadata.num_rows:,}")
    print(f"Row groups:   {pf.num_row_groups}")
    print()

    # buckets[(pid, season, season_type, zone, dist_bucket)] = [made, attempts]
    buckets = defaultdict(lambda: [0, 0])

    for rg_idx in tqdm(range(pf.num_row_groups), desc="row groups", unit="rg"):
        table = pf.read_row_group(rg_idx, columns=NEEDED_COLUMNS)
        cols = {name: table.column(name).to_pylist() for name in NEEDED_COLUMNS}
        n = len(cols["PLAYER_ID"])

        for i in range(n):
            pid_raw = cols["PLAYER_ID"][i]
            if pid_raw is None:
                continue
            try:
                pid = int(pid_raw)
            except (TypeError, ValueError):
                continue
            season_raw = cols["_season"][i]
            if season_raw is None:
                continue
            try:
                season = int(season_raw)
            except (TypeError, ValueError):
                continue
            season_type = cols["_season_type"][i] or "rg"
            zone = cols["SHOT_ZONE_BASIC"][i] or ""
            db = dist_bucket(cols["SHOT_DISTANCE"][i])
            made = 1 if cols["SHOT_MADE_FLAG"][i] else 0

            key = (pid, season, season_type, zone, db)
            b = buckets[key]
            b[1] += 1
            if made:
                b[0] += 1

        del cols
        del table

    print()
    print(f"Wrote {len(buckets):,} bucket rows. Saving CSV...")

    # Sort for stable output / better gzip ratio.
    sorted_keys = sorted(buckets.keys())

    with OUT_CSV.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["player_id", "name", "season", "season_type",
                    "zone", "dist_bucket", "made", "attempts"])
        for k in sorted_keys:
            pid, season, season_type, zone, db = k
            made, attempts = buckets[k]
            name = name_by_pid.get(pid, "")
            w.writerow([pid, name, season, season_type, zone, db, made, attempts])

    raw_size = OUT_CSV.stat().st_size

    # Pre-gzip a copy for fast network transfer. HF will also gzip on the
    # fly via Content-Encoding negotiation, but shipping a pre-gzipped
    # asset means we control the compression level and save server-side
    # CPU on every request.
    with OUT_CSV.open("rb") as fin:
        with gzip.open(OUT_CSV_GZ, "wb", compresslevel=9) as fout:
            fout.write(fin.read())
    gz_size = OUT_CSV_GZ.stat().st_size

    print()
    print("---- Summary ----")
    print(f"Rows:           {len(buckets):,}")
    print(f"CSV size:       {raw_size:,} bytes ({raw_size / 1024 / 1024:.1f} MB)")
    print(f"CSV gz size:    {gz_size:,} bytes ({gz_size / 1024 / 1024:.1f} MB)")
    print(f"Output dir:     {SHARDS_ROOT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
