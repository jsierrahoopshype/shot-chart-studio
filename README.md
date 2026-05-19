# NBA Awards Voter Selections — Dashboard Data

Three CSVs parsed from 110 official NBA per-voter ballot disclosure PDFs spanning
12 seasons (2013-14 through 2024-25).

## Files

### `nba_award_ballots.csv` — 71,459 rows
The master long-format file. **One row = one player pick on one ballot.**

| column | meaning |
|---|---|
| `season` | e.g. `2024-25` |
| `season_end_year` | integer for sorting (e.g. `2025`) |
| `award` | code: `MVP`, `DPOY`, `MIP`, `SMOY`, `COY`, `ROY`, `CPOY`, `ALL_NBA`, `ALL_DEF`, `ALL_ROOKIE` |
| `award_name` | full name |
| `voter` | reporter, canonical "FirstName LastName" |
| `affiliation` | outlet (e.g. `The Athletic`, `ESPN`, `Sacramento Bee`) |
| `team_pick` | for All-NBA/All-Def/All-Rookie: `First Team`, `Second Team`, `Third Team`. Blank for individual awards. |
| `rank` | 1-5 (slot within team for All-* awards; rank within ballot for individual awards) |
| `ballot_position` | human-readable (`1st Place`, `First Team`, etc.) |
| `points` | weighted points: 10/7/5/3/1 for MVP, 5/3/1 for other individual awards. Blank for team awards. |
| `player` | canonical "FirstName LastName" |
| `player_team` | normalized 3-letter abbreviation (e.g. `OKC`, `BOS`) |
| `player_team_raw` | as it appeared in the source PDF (`Oklahoma City`, `OKC`, `OKC.`, `(OKC)`, etc.) |

### `voters.csv` — 1,452 rows
Distinct (voter, season, affiliation) combinations.

| column | meaning |
|---|---|
| `voter` | canonical name |
| `season` | season they voted in |
| `affiliation` | outlet for that season |
| `awards_voted` | pipe-delimited list of award codes voted on |
| `ballots_count` | count of ballots cast (one per award) |

### `award_summary.csv` — 2,206 rows
Aggregated totals per (season, award, player) with rank.

For individual awards: `points`, `first_place_votes`, `voter_count`.
For team awards (All-NBA / All-Def / All-Rookie): `first_team_votes`, `second_team_votes`, `third_team_votes`, `total_votes`.

## Award structures

| award | ballot | points |
|---|---|---|
| MVP | 5-place | 10/7/5/3/1 |
| DPOY, MIP, SMOY, COY, ROY, CPOY | 3-place | 5/3/1 |
| All-NBA | 3 teams × 5 players | n/a |
| All-Defensive | 2 teams × 5 players | n/a |
| All-Rookie | 2 teams × 5 players | n/a |

CPOY (Clutch Player) only exists 2022-23 onwards.

## Coverage notes

- 12 seasons × ~9-10 awards = 110 PDFs total.
- Voter panel size: 124-131 in 2013-14 to 2015-16, then ~100 from 2016-17 onward.
- All-NBA and All-Defensive teams were positional (F/F/C/G/G) through 2022-23 and positionless from 2023-24 onward. The parser does not record position designation; if you need it, the `rank` (1-5) within `team_pick` reflects column order in the source PDF, which corresponded to F/F/C/G/G for All-NBA pre-2024 and to all positions in old All-Def files.
- Coaches are recorded in the `player` column for the COY award, with their team in `player_team`.

## Dashboard query patterns

These all work as filters/groupings on `nba_award_ballots.csv`:

**Who did Reporter X vote for as MVP this year?**
Filter `season`, `award='MVP'`, `voter='X'`. Sort by `rank`.

**Which voters had the most "lone-vote" outlier picks?**
For each `(season, award, voter, rank, player)`, group all ballots by `(season, award, player, rank)` and count distinct voters. Voters whose pick has count = 1 are outliers.

**Which players were valued by which outlets?**
Group by `(player, affiliation)` and sum `points` (or count picks). Pivot.

**Voter consistency over time**
For each voter, see their #1 MVP pick across seasons.

**MVP point evolution per player**
`SELECT season, player, SUM(points) FROM ballots WHERE award='MVP' GROUP BY season, player`
This is precomputed in `award_summary.csv`.

**Top "snubs"** (got votes but didn't make team)
For All-NBA: filter `award='ALL_NBA'`, group by `(season, player)`, sum a weighted score (3*first_team + 2*second_team + 1*third_team). The top 15 made the team. Anyone with `rank > 15` in the season is a snub candidate.

## Validation

Top vote-getters per award match the actual NBA award winners for every season 2013-14 through 2024-25 (Durant 2014, Curry 2015 & 2016, Westbrook 2017, Harden 2018, Giannis 2019 & 2020, Jokić 2021/2022/2024, Embiid 2023, SGA 2025). All-NBA First Teams cross-verify against historical records.

## Provenance

Source: official NBA per-voter ballot disclosure PDFs (`NBA_AWARDS_VOTINGS.zip`).
Parser: Python regex-based, handling 5 distinct player-pick formats and 3 distinct voter formats across the 12-year span. Zero parse errors across 110 files.
