"""
Guild War forecast builder for Freakmont (Bera 5).

Guild War pools 5 guilds with similar CP into one 150-seat ranking: every
participant's real Guild War damage earns them a position (1-150), and that
position pays a fixed number of Guild Points (see GUILD_WAR_SCORE_TABLE
below) regardless of the actual damage gap between ranks. A guild's final
standing is the sum of its members' Guild Points.

This script:
  1. Reads data/freakmont/gw-opponents.json -- a hand-maintained file
     listing this week's 4 opponent guilds (edit it each time Guild War
     re-matches).
  2. Fetches each opponent's mapleidle.gg guild page the exact same way
     scrape_guild.py already does for Freakmont, and reuses its parsing
     (parse_guild_page) to pull each opponent's roster + Guild War scores.
  3. Reuses Freakmont's own, already-scraped guild-war-current.json /
     roster.json instead of re-fetching our own page.
  4. Pools every participant (all 5 guilds) into one ranking by real
     Guild War score, assigns the fixed points for each rank per
     GUILD_WAR_SCORE_TABLE, and sums points per guild.
  5. Writes data/freakmont/gw-forecast.json for the frontend
     (gw-forecast.html / gw-forecast.js) to render.

This is a deterministic projection from the latest data on file for each
guild -- "if the war paid out right now, on these numbers." It does NOT
model no-shows/turnout (we have no historical participation data for
opponent guilds to base that on), so treat it as a snapshot, not a
guaranteed outcome -- the frontend says as much.

Design notes (mirrors scrape_guild.py):
- Only ever fetches guild pages, never per-character pages -- mapleidle.gg's
  own guild page already ships every member's Guild War score in the same
  flight-data blob roster/CP comes from, so no extra per-player requests
  are needed for this feature.
- Paced with a delay + jitter between opponent fetches, same spirit as the
  per-character pacing in scrape_guild.py, since this still hits the same
  rate-limited site.
- Safe to run even when there's no active matchup: if gw-opponents.json is
  missing, empty, or marked inactive, this exits cleanly (prints a note,
  writes nothing) so it can always be wired into the daily workflow without
  risking the main scrape.
"""

import json
import random
import time
import pathlib
import datetime

from curl_cffi import requests

import scrape_guild as sg

# --- Config -----------------------------------------------------------

DATA_DIR = sg.DATA_DIR  # data/freakmont
OPPONENTS_PATH = DATA_DIR / "gw-opponents.json"
FORECAST_PATH = DATA_DIR / "gw-forecast.json"

OUR_GUILD_NAME = "Freakmont"

OPPONENT_FETCH_DELAY_SECONDS = 8
OPPONENT_FETCH_JITTER_SECONDS = 2

# Every seat (1-150) in a Guild War bracket (5 guilds x up to 30 members)
# pays a fixed number of Guild Points for that rank, regardless of the raw
# damage gap between ranks -- this is the full official table, rank 1-150.
# Source: in-game Guild War scoring guide (guild_war_scoring_guide.md),
# as of 2026-08-31. Nexon has changed this table before across balance
# patches -- if payouts on mapleidle.gg's own Guild War Ranking screen
# stop matching this list, re-transcribe it from the current in-game
# "Guild Point Information" panel and update here.
GUILD_WAR_SCORE_TABLE = [
    1000000, 900000, 800000, 730000, 660000, 610000, 560000, 510000, 460000, 410000,
    380000, 350000, 320000, 290000, 260000, 250000, 240000, 230000, 220000, 210000,
    205000, 200000, 195000, 190000, 185000, 180000, 175000, 170000, 165000, 160000,
    157000, 154000, 151000, 148000, 145000, 142000, 139000, 136000, 133000, 130000,
    128000, 126000, 124000, 122000, 120000, 118000, 116000, 114000, 112000, 110000,
    109000, 108000, 107000, 106000, 105000, 104000, 103000, 102000, 101000, 100000,
    99000, 98000, 97000, 96000, 95000, 94000, 93000, 92000, 91000, 90000,
    89000, 88000, 87000, 86000, 85000, 84000, 83000, 82000, 81000, 80000,
    79000, 78000, 77000, 76000, 75000, 74000, 73000, 72000, 71000, 70000,
    69000, 68000, 67000, 66000, 65000, 64000, 63000, 62000, 61000, 60300,
    59600, 58900, 58200, 57500, 56800, 56100, 55400, 54700, 54000, 53300,
    52600, 51900, 51200, 50500, 49800, 49100, 48400, 47700, 47000, 46300,
    45600, 44900, 44200, 43500, 42800, 42100, 41400, 40700, 40000, 39300,
    38600, 37900, 37200, 36500, 35800, 35100, 34400, 33700, 33000, 32300,
    31600, 30900, 30200, 29500, 28800, 28100, 27400, 26700, 26000, 25300,
]


def points_for_rank(rank: int) -> int:
    """Guild Points for a given tournament rank (1-indexed). Ranks beyond
    the table (more than 150 real participants, which shouldn't happen at
    30-per-guild x 5 guilds, but a guild could in principle run more) fall
    back to the last-place value rather than erroring."""
    if rank < 1:
        return 0
    idx = min(rank, len(GUILD_WAR_SCORE_TABLE)) - 1
    return GUILD_WAR_SCORE_TABLE[idx]


# --- Load opponents config ----------------------------------------------

def load_opponents_config() -> dict | None:
    if not OPPONENTS_PATH.exists():
        print(
            f"No {OPPONENTS_PATH} found -- nothing to forecast this run. "
            "Copy gw-opponents.json.template into place and fill in this "
            "week's 4 opponent guild names to enable the War Forecast page."
        )
        return None

    try:
        config = json.loads(OPPONENTS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"{OPPONENTS_PATH} isn't valid JSON ({e}) -- skipping.")
        return None

    if not config.get("active", True):
        print(f"{OPPONENTS_PATH} is marked inactive -- skipping this run.")
        return None

    opponents = [n for n in config.get("opponents", []) if n]
    if not opponents:
        print(f"{OPPONENTS_PATH} has no opponent guild names -- skipping.")
        return None
    if len(opponents) != 4:
        print(
            f"Note: {OPPONENTS_PATH} lists {len(opponents)} opponents "
            "(Guild War is normally a 5-guild bracket, i.e. 4 opponents) "
            "-- continuing anyway with whatever's listed."
        )

    config["opponents"] = opponents
    return config


# --- Fetch + parse an arbitrary guild's mapleidle.gg page ----------------

def fetch_guild_war_field(guild_name: str) -> dict:
    """Fetch and parse one guild's mapleidle.gg page, returning
    {"members": [...], "war_entries": [...]} in the same shape
    parse_guild_page() already produces for Freakmont."""
    url = f"{sg.MAPLEIDLE_BASE_URL}/guild/{sg.MAPLEIDLE_REGION}/{guild_name}"
    resp = sg._fetch(url)
    html = resp.text
    sg.cache_raw_html(html, source=f"gwforecast-{guild_name}")
    parsed = sg.parse_guild_page(html)
    return {
        "members": parsed["members"],
        "war_entries": parsed["scores"].get("guild_war", []),
    }


def load_our_war_field() -> dict:
    """Freakmont's own roster + Guild War scores, read back from the files
    the daily scrape already wrote -- no need to re-fetch our own page."""
    roster = sg._read_json(DATA_DIR / "roster.json", [])
    gw_current = sg._read_json(DATA_DIR / "guild-war-current.json", {})
    return {
        "members": roster,
        "war_entries": (gw_current or {}).get("entries", []),
    }


# --- Build the forecast ---------------------------------------------------

def build_forecast(guild_fields: dict) -> dict:
    """guild_fields: {guild_name: {"members": [...], "war_entries": [...]}}"""

    all_participants = []
    for guild_name, field in guild_fields.items():
        for entry in field["war_entries"]:
            score = entry.get("score")
            if not isinstance(score, (int, float)):
                continue  # no recorded Guild War run -- excluded from the field
            all_participants.append({
                "name": entry.get("name"),
                "class": entry.get("class"),
                "level": entry.get("level"),
                "score": score,
                "guild": guild_name,
                "isUs": guild_name == OUR_GUILD_NAME,
            })

    all_participants.sort(key=lambda p: p["score"], reverse=True)

    leaderboard = []
    guild_points = {name: 0 for name in guild_fields}
    for i, p in enumerate(all_participants):
        rank = i + 1
        points = points_for_rank(rank)
        guild_points[p["guild"]] += points
        leaderboard.append({
            "rank": rank,
            "name": p["name"],
            "guild": p["guild"],
            "class": p["class"],
            "level": p["level"],
            "score": p["score"],
            "points": points,
            "isUs": p["isUs"],
        })

    guild_standings = [
        {
            "name": guild_name,
            "isUs": guild_name == OUR_GUILD_NAME,
            "memberCount": len(field["members"]),
            "participantCount": sum(
                1 for e in field["war_entries"]
                if isinstance(e.get("score"), (int, float))
            ),
            "totalPoints": guild_points[guild_name],
        }
        for guild_name, field in guild_fields.items()
    ]
    guild_standings.sort(key=lambda g: g["totalPoints"], reverse=True)
    for i, g in enumerate(guild_standings):
        g["projectedRank"] = i + 1

    return {
        "date": datetime.date.today().isoformat(),
        "our_guild": OUR_GUILD_NAME,
        "guilds": guild_standings,
        "leaderboard": leaderboard,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# --- Main -------------------------------------------------------------

def main():
    config = load_opponents_config()
    if config is None:
        return

    opponents = config["opponents"]
    guild_fields = {OUR_GUILD_NAME: load_our_war_field()}

    print(f"=== Guild War forecast: {OUR_GUILD_NAME} vs {', '.join(opponents)} ===")
    for i, opponent in enumerate(opponents):
        try:
            field = fetch_guild_war_field(opponent)
        except requests.exceptions.HTTPError as e:
            if "429" in str(e):
                print(
                    f"Rate limited fetching '{opponent}' -- stopping here "
                    f"rather than continuing to hit a throttled site. "
                    f"Rerun later to pick up the rest; guilds already "
                    f"fetched this run are not written until every "
                    f"opponent succeeds, so a partial run changes nothing "
                    f"on the site."
                )
                return
            print(f"  {opponent}: fetch failed ({e}), aborting this run.")
            return

        guild_fields[opponent] = field
        print(f"  {opponent}: {len(field['members'])} members, "
              f"{len(field['war_entries'])} with a recorded Guild War score")

        if i < len(opponents) - 1:
            time.sleep(OPPONENT_FETCH_DELAY_SECONDS
                       + random.uniform(-OPPONENT_FETCH_JITTER_SECONDS,
                                         OPPONENT_FETCH_JITTER_SECONDS))

    forecast = build_forecast(guild_fields)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    sg._write_json(FORECAST_PATH, forecast)

    print(f"\nWrote {FORECAST_PATH}")
    for g in forecast["guilds"]:
        marker = " (us)" if g["isUs"] else ""
        print(f"  #{g['projectedRank']} {g['name']}{marker}: "
              f"{g['totalPoints']:,} pts ({g['participantCount']} scored)")


if __name__ == "__main__":
    main()
