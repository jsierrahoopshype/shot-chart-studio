"""Build per-player shot shards for Shot Chart Studio (v2, column-oriented).

Same data, more compact wire format:

  * Column-oriented within each shard. Instead of `[{...shot1...}, {...shot2...}]`
    we store `{"x":[...], "y":[...], ...}` so JSON keys appear once per file
    instead of once per shot.

  * String interning. For zone, action, game_id, and team fields we keep
    a per-shard lookup table at the top and use small integer indexes in
    the column arrays.

Result: ~960 MB -> ~340 MB total, LeBron from 6 MB to ~2 MB.

Output layout:
  dist/
    players.json
    players/
      00/2.json, 3.json, ...
      25/2544.json   (LeBron)
      ...

Run: python scripts/build_shot_shards.py
"""

from __future__ import annotations

import json
import shutil
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
    "GAME_ID",
    "GAME_DATE",
    "HTM",
    "VTM",
    "PLAYER_ID",
    "PERIOD",
    "MINUTES_REMAINING",
    "SECONDS_REMAINING",
    "ACTION_TYPE",
    "SHOT_ZONE_BASIC",
    "SHOT_DISTANCE",
    "LOC_X",
    "LOC_Y",
    "SHOT_MADE_FLAG",
    "SHOT_TYPE",
    "_season",
    "_season_type",
]

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"
PLAYERS_CATALOG = ROOT / "data" / "players.json"
SHARDS_DIR = DIST_DIR / "players"


def shard_prefix(player_id: int) -> str:
    return str(player_id // 100)


def normalize_game_date(value) -> str:
    if value is None:
        return ""
    s = str(value)
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10]


def safe_int(v, default=0) -> int:
    if v is None:
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def safe_str(v) -> str:
    return "" if v is None else str(v)


class Interner:
    """Maps string -> int index, preserves insertion order, exposes vocab list."""

    __slots__ = ("_idx", "_vocab")

    def __init__(self) -> None:
        self._idx: dict[str, int] = {}
        self._vocab: list[str] = []

    def add(self, s: str) -> int:
        i = self._idx.get(s)
        if i is None:
            i = len(self._vocab)
            self._idx[s] = i
            self._vocab.append(s)
        return i

    @property
    def vocab(self) -> list[str]:
        return self._vocab


def build_shard_payload(pid: int, raw_shots: list[dict], catalog: dict) -> dict:
    """Convert a list of per-shot dicts into the column-oriented payload."""
    # Deterministic order: by date, then game, then period, then time-into-period.
    raw_shots.sort(key=lambda s: (s["dt"], s["g_str"], s["p"], -s["t"]))

    games = Interner()
    teams = Interner()
    zones = Interner()
    actions = Interner()

    n = len(raw_shots)

    col_g = [0] * n
    col_dt = [""] * n
    col_h = [0] * n
    col_v = [0] * n
    col_p = [0] * n
    col_t = [0] * n
    col_a = [0] * n
    col_z = [0] * n
    col_d = [0] * n
    col_x = [0] * n
    col_y = [0] * n
    col_m = [0] * n
    col_three = [0] * n
    col_s = [0] * n
    col_po = [0] * n

    for i, s in enumerate(raw_shots):
        col_g[i] = games.add(s["g_str"])
        col_dt[i] = s["dt"]
        col_h[i] = teams.add(s["h_str"])
        col_v[i] = teams.add(s["v_str"])
        col_p[i] = s["p"]
        col_t[i] = s["t"]
        col_a[i] = actions.add(s["a_str"])
        col_z[i] = zones.add(s["z_str"])
        col_d[i] = s["d"]
        col_x[i] = s["x"]
        col_y[i] = s["y"]
        col_m[i] = s["m"]
        col_three[i] = s["three"]
        col_s[i] = s["s"]
        col_po[i] = s["po"]

    cat_entry = catalog.get(str(pid), {})

    return {
        "player_id": pid,
        "name": cat_entry.get("name", ""),
        "first_season": cat_entry.get("first_season"),
        "last_season": cat_entry.get("last_season"),
        "shot_count": n,
        # Lookup tables. Kept short, referenced by integer index in `shots`.
        "game_codes": games.vocab,
        "team_codes": teams.vocab,
        "zone_codes": zones.vocab,
        "action_codes": actions.vocab,
        "shots": {
            "g": col_g,
            "dt": col_dt,
            "h": col_h,
            "v": col_v,
            "p": col_p,
            "t": col_t,
            "a": col_a,
            "z": col_z,
            "d": col_d,
            "x": col_x,
            "y": col_y,
            "m": col_m,
            "3": col_three,
            "s": col_s,
            "po": col_po,
        },
    }


def main() -> int:
    if not PLAYERS_CATALOG.exists():
        print(
            f"ERROR: {PLAYERS_CATALOG} missing. Run build_player_catalog.py first.",
            file=sys.stderr,
        )
        return 1

    if DIST_DIR.exists():
        print(f"Removing existing {DIST_DIR}...")
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)

    with PLAYERS_CATALOG.open(encoding="utf-8") as f:
        catalog = json.load(f)

    (DIST_DIR / "players.json").write_text(
        json.dumps(catalog, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )

    # Also write a format manifest so consumers know how to decode the shards.
    (DIST_DIR / "format.json").write_text(
        json.dumps(
            {
                "version": 2,
                "layout": "column-oriented",
                "interned_fields": ["g", "h", "v", "z", "a"],
                "lookup_tables": {
                    "g": "game_codes",
                    "h": "team_codes",
                    "v": "team_codes",
                    "z": "zone_codes",
                    "a": "action_codes",
                },
                "fields": {
                    "g": "GAME_ID (interned)",
                    "dt": "GAME_DATE (YYYY-MM-DD)",
                    "h": "home team abbr (interned)",
                    "v": "visiting team abbr (interned)",
                    "p": "period (1=Q1..4=Q4, 5+=OT)",
                    "t": "seconds remaining in period",
                    "a": "ACTION_TYPE (interned)",
                    "z": "SHOT_ZONE_BASIC (interned)",
                    "d": "SHOT_DISTANCE (feet)",
                    "x": "LOC_X (tenths of feet from center)",
                    "y": "LOC_Y (tenths of feet from baseline)",
                    "m": "1=made, 0=missed",
                    "3": "1=three-pointer, 0=two-pointer",
                    "s": "season (start year, e.g. 2024 = 2024/25)",
                    "po": "1=playoffs, 0=regular season",
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"Downloading {PARQUET_PATH_IN_REPO} from {REPO_ID}...")
    parquet_path = hf_hub_download(
        repo_id=REPO_ID,
        repo_type=REPO_TYPE,
        filename=PARQUET_PATH_IN_REPO,
    )
    print(f"Local cache: {parquet_path}")

    pf = pq.ParquetFile(parquet_path)
    print(f"Parquet rows: {pf.metadata.num_rows:,}")
    print(f"Row groups:   {pf.num_row_groups}")
    print()

    # First pass: collect raw shots per player. We keep raw strings here
    # rather than interning during ingest, because each player gets its
    # own interner (a string interned globally would still need a per-
    # player remap on write).
    by_player: dict[int, list[dict]] = defaultdict(list)

    for rg_idx in tqdm(range(pf.num_row_groups), desc="row groups", unit="rg"):
        table = pf.read_row_group(rg_idx, columns=NEEDED_COLUMNS)
        cols = {name: table.column(name).to_pylist() for name in NEEDED_COLUMNS}
        n = len(cols["PLAYER_ID"])

        for i in range(n):
            pid = safe_int(cols["PLAYER_ID"][i])
            shot_type = safe_str(cols["SHOT_TYPE"][i])
            is_three = 1 if "3PT" in shot_type else 0
            minutes = safe_int(cols["MINUTES_REMAINING"][i])
            seconds = safe_int(cols["SECONDS_REMAINING"][i])

            by_player[pid].append({
                "g_str": safe_str(cols["GAME_ID"][i]),
                "dt": normalize_game_date(cols["GAME_DATE"][i]),
                "h_str": safe_str(cols["HTM"][i]),
                "v_str": safe_str(cols["VTM"][i]),
                "p": safe_int(cols["PERIOD"][i]),
                "t": minutes * 60 + seconds,
                "a_str": safe_str(cols["ACTION_TYPE"][i]),
                "z_str": safe_str(cols["SHOT_ZONE_BASIC"][i]),
                "d": safe_int(cols["SHOT_DISTANCE"][i]),
                "x": safe_int(cols["LOC_X"][i]),
                "y": safe_int(cols["LOC_Y"][i]),
                "m": 1 if cols["SHOT_MADE_FLAG"][i] else 0,
                "three": is_three,
                "s": safe_int(cols["_season"][i]),
                "po": 1 if safe_str(cols["_season_type"][i]) == "po" else 0,
            })

        del cols
        del table

    print()
    print(f"Built shot lists for {len(by_player):,} players.")
    print("Writing shards...")

    written = 0
    total_bytes = 0
    largest = ("", 0)
    smallest = ("", float("inf"))

    for pid, shots in tqdm(by_player.items(), desc="shards", unit="player"):
        payload = build_shard_payload(pid, shots, catalog)

        sub = SHARDS_DIR / shard_prefix(pid)
        sub.mkdir(parents=True, exist_ok=True)
        out_path = sub / f"{pid}.json"
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        out_path.write_text(text, encoding="utf-8")

        written += 1
        size = len(text.encode("utf-8"))
        total_bytes += size
        if size > largest[1]:
            largest = (payload["name"] or str(pid), size)
        if size < smallest[1]:
            smallest = (payload["name"] or str(pid), size)

    print()
    print("---- Summary ----")
    print(f"Players written: {written:,}")
    print(f"Total bytes:     {total_bytes:,} ({total_bytes / 1024 / 1024:.1f} MB)")
    print(f"Avg per player:  {total_bytes // written:,} bytes")
    print(f"Largest:         {largest[0]} ({largest[1]:,} bytes)")
    print(f"Smallest:        {smallest[0]} ({smallest[1]:,} bytes)")
    print()
    print(f"Output dir: {DIST_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
