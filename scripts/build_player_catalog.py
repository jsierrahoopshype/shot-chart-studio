"""Build a player catalog from the cdechoch/nba-data-archive shot detail parquet.

Streams only the columns we need (PLAYER_ID, PLAYER_NAME, _season) via the
HuggingFace fsspec backend, so we avoid pulling the full 60+ MB file.

Output: data/players.json
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem

REPO_PATH = "datasets/cdechoch/nba-data-archive/merged/shotdetail.parquet"
COLUMNS = ["PLAYER_ID", "PLAYER_NAME", "_season"]

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = ROOT / "data" / "players.json"


def load_shot_columns():
    fs = HfFileSystem()
    with fs.open(REPO_PATH, "rb") as f:
        return pq.read_table(f, columns=COLUMNS).to_pandas()


def build_catalog(df):
    catalog: dict[str, dict] = {}

    for player_id, group in df.groupby("PLAYER_ID", sort=False):
        names = group["PLAYER_NAME"].tolist()
        seasons = group["_season"].tolist()

        name_counts = Counter(names)
        top_count = max(name_counts.values())
        candidates = {n for n, c in name_counts.items() if c == top_count}

        if len(candidates) == 1:
            canonical = next(iter(candidates))
        else:
            # Tie-breaker: spelling from the most recent season the player played.
            latest_season = max(seasons)
            latest_names = [
                n for n, s in zip(names, seasons)
                if s == latest_season and n in candidates
            ]
            canonical = (
                Counter(latest_names).most_common(1)[0][0]
                if latest_names
                else sorted(candidates)[0]
            )

        distinct_seasons = sorted({int(s) for s in seasons})
        catalog[str(int(player_id))] = {
            "name": canonical,
            "seasons": distinct_seasons,
            "first_season": distinct_seasons[0],
            "last_season": distinct_seasons[-1],
            "shot_count": int(len(group)),
        }

    return dict(sorted(catalog.items(), key=lambda kv: int(kv[0])))


def main() -> None:
    print(f"Reading {REPO_PATH} (columns: {', '.join(COLUMNS)})...")
    df = load_shot_columns()
    print(f"Loaded {len(df):,} rows.")

    catalog = build_catalog(df)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
        f.write("\n")

    total_players = len(catalog)
    total_shots = sum(p["shot_count"] for p in catalog.values())
    size_bytes = OUTPUT_PATH.stat().st_size
    size_kb = size_bytes / 1024

    print("---- Summary ----")
    print(f"Total players: {total_players:,}")
    print(f"Total shots:   {total_shots:,}")
    print(f"Output file:   {OUTPUT_PATH}")
    print(f"File size:     {size_bytes:,} bytes ({size_kb:,.1f} KB)")


if __name__ == "__main__":
    main()
