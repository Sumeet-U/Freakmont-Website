"""
Daily guild-data puller for Freakmont (Bera 5). We are simply attempting to lightweight website to track our guild, inspired by https://gocelest.com/

Key discovery (via HAR inspection of the real page): mapleidle.gg is a Next.js
App Router site. The guild page is server-rendered, and the full member roster
ships as structured JSON embedded in the page's own React Server Component
("flight") data -- inside <script>self.__next_f.push([1,"..."])</script> tags.
This is much more reliable than parsing HTML table cells: it's the same typed
data the site's frontend itself consumes, it survives redesigns of the visual
table, and it includes fields (raw cp as an integer, account_id, rank) that
aren't even fully visible in the rendered UI.

Design notes:
- Runs once per day (cron / GitHub Actions schedule handles that, not this
  script).
- Identifies itself honestly via User-Agent so the maintainer can see/block it
  if something goes wrong on their end.
- Single page fetch per guild -- no concurrency, no burst traffic.
- Caches the raw HTML locally so re-runs / debugging don't require re-hitting
  the site.
"""

import re
import json
import time
import pathlib
import datetime

import requests

# --- Config -----------------------------------------------------------

MAPLEIDLE_BASE_URL = "https://mapleidle.gg"
MAPLEIDLE_REGION = "bera"
MSIDLE_BASE_URL = "https://www.msidle.gg"

GUILD_NAME = "freakmont"  # used as the folder name under data/
MAPLEIDLE_GUILD_PATH = "/guild/bera/Freakmont"
MSIDLE_GUILD_PATH = "/guilds/bera/Freakmont"

HEADERS = {
    "User-Agent": "CelestAllianceBot/1.0 (Discord: Kobe4Life https://discord.com/users/135969126425427968",
}

DATA_DIR = pathlib.Path("data") / GUILD_NAME
DATA_DIR.mkdir(parents=True, exist_ok=True)

RAW_CACHE_DIR = pathlib.Path("raw_cache")
RAW_CACHE_DIR.mkdir(exist_ok=True)

# Category key -> filename stem, matching the gocelest.com convention
# (e.g. conquest-current.json, conquest-prev.json, conquest-archive.json)
GAME_MODE_FILE_STEMS = {
    "conquest": "conquest",
    "world_boss": "world-boss",
    "training_ground": "training-ground",
    "guild_war": "guild-war",
    "guild_boss_battle": "guild-boss-battle",
}


# --- Fetch --------------------------------------------------------------

def _fetch(url: str, extra_headers: dict = None) -> requests.Response:
    headers = {**HEADERS, **(extra_headers or {})}
    resp = requests.get(url, headers=headers, timeout=15)

    if resp.status_code == 429:
        print(f"Rate limited (429) on {url}.")

        # Print any rate-limit-related headers the site sent back -- these
        # often tell us exactly when it's safe to retry, instead of guessing.
        rate_limit_headers = {
            k: v for k, v in resp.headers.items()
            if k.lower().startswith(("retry-after", "x-ratelimit", "ratelimit"))
        }
        if rate_limit_headers:
            print("Rate-limit info from response headers:")
            for k, v in rate_limit_headers.items():
                print(f"  {k}: {v}")
        else:
            print(
                "No rate-limit headers in the response -- the site didn't "
                "tell us when it resets. This usually clears in a few "
                "minutes to an hour. Since this only runs once a day, this "
                "shouldn't come up in normal scheduled use -- it's most "
                "likely from repeated manual testing in a short window."
            )
        resp.raise_for_status()

    resp.raise_for_status()
    return resp


def fetch_mapleidle_page() -> str:
    return _fetch(f"{MAPLEIDLE_BASE_URL}{MAPLEIDLE_GUILD_PATH}").text


def fetch_mapleidle_character_page(name: str) -> str:
    return _fetch(f"{MAPLEIDLE_BASE_URL}/characters/{MAPLEIDLE_REGION}/{name}").text


def fetch_msidle_page() -> str:
    return _fetch(f"{MSIDLE_BASE_URL}{MSIDLE_GUILD_PATH}").text
    return resp.text


def cache_raw_html(html: str, source: str) -> None:
    today = datetime.date.today().isoformat()
    out_path = RAW_CACHE_DIR / f"{GUILD_NAME}_{source}_{today}.html"
    out_path.write_text(html, encoding="utf-8")


# --- Parse ----------------------------------------------------------------
# Next.js ships server-computed data as JSON inside script tags shaped like:
#   self.__next_f.push([1,"73:[\"$\",\"$L80\",null,{\"members\":[...]}]"])
# Each chunk, once unicode-unescaped, is (after a leading "<id>:") valid JSON
# -- the "$"/"$Lxx" entries are just ordinary JSON strings that React uses
# internally, so a normal json.loads() handles them fine. We parse every
# chunk and walk the resulting objects looking for a "members" list.

_FLIGHT_CHUNK_RE = re.compile(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', re.DOTALL)
_CHUNK_SPLIT_RE = re.compile(r'(?=\d+:)')
_CHUNK_PREFIX_RE = re.compile(r'^(\d+):(.*)', re.DOTALL)


def _extract_flight_json_objects(html: str) -> list:
    """Pull every parseable JSON object/array out of the page's embedded
    Next.js flight data."""
    objects = []
    for raw_chunk in _FLIGHT_CHUNK_RE.findall(html):
        decoded = raw_chunk.encode().decode("unicode_escape")
        for part in _CHUNK_SPLIT_RE.split(decoded):
            m = _CHUNK_PREFIX_RE.match(part)
            if not m:
                continue
            body = m.group(2).strip()
            if not body or body[0] not in "[{":
                continue
            try:
                objects.append(json.loads(body))
            except json.JSONDecodeError:
                continue
    return objects


def _find_key(obj, key: str):
    """Depth-first search for the first list value under the given key,
    anywhere in a nested dict/list structure."""
    if isinstance(obj, dict):
        if key in obj and isinstance(obj[key], list):
            return obj[key]
        for v in obj.values():
            found = _find_key(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_key(v, key)
            if found is not None:
                return found
    return None


def _find_dicts_with_keys(obj, required_keys: set, results=None) -> list:
    """Depth-first collection of every dict anywhere in the structure that
    contains all of `required_keys`. Used for mapleidle.gg's character page,
    where data ships as individual component-prop dicts (e.g. one per rank
    card) rather than one clean named array like the guild page's
    "members" list."""
    if results is None:
        results = []
    if isinstance(obj, dict):
        if required_keys.issubset(obj.keys()):
            results.append(obj)
        for v in obj.values():
            _find_dicts_with_keys(v, required_keys, results)
    elif isinstance(obj, list):
        for v in obj:
            _find_dicts_with_keys(v, required_keys, results)
    return results


def _slugify_label(label: str) -> str:
    return label.strip().lower().replace(" ", "_")


# --- CP display formatting -------------------------------------------------
# Reverse-engineered from gocelest.com's own display format (verified against
# several known values, e.g. 17083000000000000 -> "17AA 83T"):
# numbers are grouped in powers of 1000, with suffixes K/M/B/T, then rolling
# into double letters AA, AB, AC... (like spreadsheet column names) for
# anything bigger than a trillion. The display shows the top two non-zero
# groups, e.g. "12AA 214T" = 12*1000^5 + 214*1000^4.

_CP_SUFFIXES = ["", "K", "M", "B", "T"]


def _cp_suffix_for_power(p: int) -> str:
    if p < len(_CP_SUFFIXES):
        return _CP_SUFFIXES[p]
    j = p - len(_CP_SUFFIXES)
    first = chr(65 + j // 26)
    second = chr(65 + j % 26)
    return first + second


def format_cp(n) -> str:
    """Convert a raw integer CP value into gocelest.com-style display
    notation, e.g. 12214046153136860 -> '12AA 214T'."""
    if n is None:
        return None
    n = int(n)
    if n == 0:
        return "0"

    p = 0
    while 1000 ** (p + 1) <= n:
        p += 1

    top = n // (1000 ** p)
    remainder = n % (1000 ** p)

    if p == 0:
        return str(top)

    next_p = p - 1
    next_val = remainder // (1000 ** next_p)
    top_str = f"{top}{_cp_suffix_for_power(p)}"
    if next_val == 0:
        return top_str
    return f"{top_str} {next_val}{_cp_suffix_for_power(next_p)}"


def parse_guild_page(html: str) -> dict:
    flight_objects = _extract_flight_json_objects(html)

    def first_match(key: str):
        for obj in flight_objects:
            found = _find_key(obj, key)
            if found:
                return found
        return []

    members_raw = first_match("members")
    members = []
    for m in members_raw:
        cp_raw = m.get("cp")
        members.append({
            "name": m.get("name"),
            "class": m.get("job"),
            "level": m.get("level"),
            "cpRaw": cp_raw,
            "cpDisplay": format_cp(cp_raw),
        })

    # Game-mode leaderboards: all five ship in this same page load (confirmed
    # via HAR -- clicking tabs in the browser fired no new requests), each
    # keyed by account_id/name/score/rank, same shape as members.
    game_modes = {
        "conquest": "conquest",
        "world_boss": "worldBoss",
        "training_ground": "training",
        "guild_war": "war",
        "guild_boss_battle": "bossBattle",
    }
    scores = {}
    for our_key, source_key in game_modes.items():
        raw = first_match(source_key)
        scores[our_key] = [
            {
                "name": entry.get("name"),
                "class": entry.get("job"),
                "level": entry.get("level"),
                "score": entry.get("score"),
                "rank": entry.get("rank"),
            }
            for entry in raw
        ]

    return {
        "members": members,
        "scores": scores,
        "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# --- Parse (mapleidle.gg character page) -----------------------------------
# Same flight-data mechanism as the guild page, but the shape is different:
# instead of one clean "members" array, the rank cards (Global/Server/Server
# Bracket/Class) and performance cards (one per game mode) each ship as their
# own small component-prop dict scattered through the tree -- e.g.
#   {"label":"Global Rank","rank":744,"total":226097,...}
#   {"label":"Guild Conquest","score":943258280202.17,"subtitle":"Updated Aug 23",...}
# So instead of pulling a single named list, we collect every dict anywhere
# in the tree that has the right shape (_find_dicts_with_keys), keyed by a
# slugified version of its own "label" field.
#
# The one clean array here is "chartData" -- a genuine daily history of
# cp/level/popularity/global_rank going back weeks. mapleidle.gg is already
# tracking this server-side; we're just reading it, not computing it
# ourselves.

def parse_mapleidle_character_page(html: str) -> dict:
    flight_objects = _extract_flight_json_objects(html)

    rank_cards = []
    perf_cards = []
    history_raw = []
    for obj in flight_objects:
        rank_cards.extend(_find_dicts_with_keys(obj, {"label", "rank", "total"}))
        perf_cards.extend(_find_dicts_with_keys(obj, {"label", "score", "subtitle"}))
        if not history_raw:
            found = _find_dicts_with_keys(obj, {"date", "cp", "global_rank"})
            if found:
                history_raw = found

    ranks = {}
    for card in rank_cards:
        key = _slugify_label(card.get("label", ""))
        if key and key not in ranks:  # first occurrence wins if re-rendered
            ranks[key] = {"rank": card.get("rank"), "total": card.get("total")}

    performance = {}
    for card in perf_cards:
        key = _slugify_label(card.get("label", ""))
        if key and key not in performance:
            subtitle = (card.get("subtitle") or "").replace("Updated ", "").strip()
            performance[key] = {
                "score": card.get("score"),
                "updated": subtitle or None,
            }

    seen_dates = set()
    history = []
    for entry in history_raw:
        d = entry.get("date")
        if d in seen_dates:
            continue
        seen_dates.add(d)
        cp_raw = entry.get("cp")
        history.append({
            "date": d,
            "cpRaw": cp_raw,
            "cpDisplay": format_cp(cp_raw),
            "level": entry.get("level"),
            "globalRank": entry.get("global_rank"),
        })

    return {
        "ranks": ranks,
        "performance": performance,
        "history": history,
        "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# --- Parse (msidle.gg) ------------------------------------------------
# msidle.gg is an Inertia.js (Laravel) app, server-rendered. The full page
# data -- including every member's power (cp), level, job, and their best
# damage in each category -- ships as one JSON blob embedded directly in
# the initial HTML:
#   <script data-page="app" type="application/json">{...}</script>
# Confirmed via HAR that the member list is IDENTICAL across all five tab
# URLs (power/guild-conquest/guild-war/guild-training-ground/guild-boss) --
# only the guild's own aggregate rank differs per tab. So a single fetch of
# the base guild URL gets everything; no need to hit all five endpoints.
#
# Per-category "rank" isn't provided per-member (the list order reflects
# power, not category score), so we sort locally and assign rank ourselves.
#
# Note: guild_war is intentionally omitted -- per-member war damage on
# msidle.gg is user-submitted data, not verified, so it's excluded here.

_MSIDLE_DATA_PAGE_RE = re.compile(
    r'<script data-page="app" type="application/json">(.*?)</script>',
    re.DOTALL,
)


def parse_msidle_page(html: str) -> dict:
    m = _MSIDLE_DATA_PAGE_RE.search(html)
    if not m:
        return {"members": [], "scores": {}, "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}

    data = json.loads(m.group(1))
    members_raw = data.get("props", {}).get("members", [])

    members = []
    for mem in members_raw:
        cp_raw = mem.get("power")
        members.append({
            "name": mem.get("name"),
            "class": (mem.get("job") or {}).get("name"),
            "level": mem.get("level"),
            "cpRaw": cp_raw,
            "cpDisplay": format_cp(cp_raw),
        })

    # field on the raw member record -> our category key
    # (guild_war deliberately excluded -- see note above)
    damage_fields = {
        "conquest": "best_guild_conquest_damage",
        "training_ground": "best_guild_training_ground_damage",
        "guild_boss_battle": "best_guild_boss_damage",
    }

    scores = {}
    for our_key, field in damage_fields.items():
        entries = []
        for mem in members_raw:
            raw_val = mem.get(field)
            if raw_val is None:
                continue
            entries.append({
                "name": mem.get("name"),
                "class": (mem.get("job") or {}).get("name"),
                "level": mem.get("level"),
                "score": int(raw_val),
            })
        entries.sort(key=lambda e: e["score"], reverse=True)
        for i, entry in enumerate(entries, start=1):
            entry["rank"] = i
        scores[our_key] = entries

    return {
        "members": members,
        "scores": scores,
        "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# --- Fetch + parse (msidle.gg character page) ------------------------------
# msidle.gg's character page uses Inertia's "deferred props" pattern: the
# initial HTML only has base character info. The rest -- ranks, stats,
# scoreComparison, and every *History array -- loads via separate "partial
# reload" requests, each asking for one deferred group by name via the
# X-Inertia-Partial-Data header, matched to a version token from the
# initial load.
#
# Rather than hardcoding which props belong to which group, we read the
# page's own "deferredProps" field and replay exactly the requests the real
# frontend would make -- so if msidle.gg ever changes the grouping, this
# keeps working without edits here.
#
# This is a genuinely reliable secondary source: msidle.gg already tracks
# real per-character history server-side (powerHistory, guildConquestHistory,
# etc.), and computes a "vs expected for this CP" comparison for us
# (scoreComparison) -- we don't have to build that ourselves.

def fetch_msidle_character_partial(name: str, partial_data: str, version: str) -> dict:
    url = f"{MSIDLE_BASE_URL}{MSIDLE_CHARACTER_PATH_TEMPLATE.format(name=name)}"
    resp = _fetch(url, extra_headers={
        "X-Inertia": "true",
        "X-Inertia-Version": version,
        "X-Inertia-Partial-Component": "Characters/Show",
        "X-Inertia-Partial-Data": partial_data,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "text/html, application/xhtml+xml",
        "Referer": url,
    })
    return resp.json()


def fetch_msidle_character(name: str) -> dict:
    """Fetch a character's full page data: base info from the initial HTML,
    then every deferred prop group via its own partial-reload request."""
    url = f"{MSIDLE_BASE_URL}{MSIDLE_CHARACTER_PATH_TEMPLATE.format(name=name)}"
    html = _fetch(url).text

    m = _MSIDLE_DATA_PAGE_RE.search(html)
    if not m:
        raise ValueError(f"Could not find embedded data-page JSON for {name}")

    base = json.loads(m.group(1))
    version = base.get("version")
    deferred_groups = base.get("props", {}).get("deferredProps") or base.get("deferredProps") or {}

    props = dict(base.get("props", {}))
    for group_name, prop_names in deferred_groups.items():
        partial_data = ",".join(prop_names)
        try:
            partial = fetch_msidle_character_partial(name, partial_data, version)
        except requests.exceptions.HTTPError as e:
            print(f"    partial '{group_name}' failed for {name}: {e}")
            continue
        props.update(partial.get("props", {}))
        time.sleep(MSIDLE_CHARACTER_SUBREQUEST_DELAY_SECONDS)

    return props


_MSIDLE_STAT_FIELD_TO_CATEGORY = {
    "best_guild_conquest_damage": "conquest",
    "best_guild_training_ground_damage": "training_ground",
    "best_guild_boss_damage": "guild_boss_battle",
    "best_guild_war_damage": "guild_war",
    "best_world_boss_damage": "world_boss",
}

_MSIDLE_HISTORY_FIELD_TO_CATEGORY = {
    "guildConquestHistory": "conquest_history",
    "guildTrainingGroundHistory": "training_ground_history",
    "guildBossHistory": "guild_boss_battle_history",
    "guildWarHistory": "guild_war_history",
    "worldBossHistory": "world_boss_history",
}


def parse_msidle_character_props(props: dict) -> dict:
    character = props.get("character", {}) or {}
    cp_raw = character.get("power")

    ranks_raw = props.get("ranks", {}) or {}
    ranks = {
        key: {"rank": val.get("rank"), "percentile": val.get("percentile")}
        for key, val in ranks_raw.items()
        if isinstance(val, dict)
    }

    stats_raw = props.get("stats", {}) or {}
    performance = {}
    for field, category in _MSIDLE_STAT_FIELD_TO_CATEGORY.items():
        score = stats_raw.get(field)
        if score is None:
            continue
        performance[category] = {
            "score": int(score),
            "percentile": stats_raw.get(field.replace("_damage", "_percentile")),
            "updated": stats_raw.get(field.replace("_damage", "_updated_at")),
        }

    comparison_raw = props.get("scoreComparison", {}) or {}
    comparison = {}
    for mode_key, entry in comparison_raw.items():
        if not entry:
            continue
        comparison[mode_key] = {
            "score": entry.get("score"),
            "vs_all_pct": entry.get("vs_all"),
            "vs_class_pct": entry.get("vs_class"),
            "date": entry.get("date"),
        }

    history = {}
    for field, out_key in _MSIDLE_HISTORY_FIELD_TO_CATEGORY.items():
        entries = props.get(field) or []
        history[out_key] = [
            {"date": e.get("date"), "score": e.get("damage")} for e in entries
        ]
    power_history = props.get("powerHistory") or []
    history["cp_history"] = [
        {
            "date": e.get("date"),
            "cpRaw": e.get("power"),
            "cpDisplay": format_cp(e.get("power")),
        }
        for e in power_history
    ]
    level_history = props.get("levelHistory") or []
    history["level_history"] = [
        {"date": e.get("date"), "level": e.get("level")} for e in level_history
    ]

    return {
        "character": {
            "name": character.get("name"),
            "class": (character.get("job") or {}).get("name"),
            "level": character.get("level"),
            "cpRaw": cp_raw,
            "cpDisplay": format_cp(cp_raw),
            "fame": character.get("fame"),
        },
        "ranks": ranks,
        "performance": performance,
        "scoreComparison": comparison,
        "history": history,
        "scraped_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


# --- Output: file-per-category with current/prev/archive rotation --------
# Mirrors gocelest.com's own structure: a flat roster.json, plus one file
# per game mode split into "-current" (this run's snapshot), "-prev" (the
# snapshot before this one), and "-archive" (every snapshot ever taken,
# appended over time so history isn't lost).

def _write_json(path: pathlib.Path, data) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _read_json(path: pathlib.Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def write_roster(members: list, filename: str = "roster.json") -> None:
    _write_json(DATA_DIR / filename, members)


def write_category(file_stem: str, entries: list, snapshot_date: str) -> None:
    current_path = DATA_DIR / f"{file_stem}-current.json"
    prev_path = DATA_DIR / f"{file_stem}-prev.json"
    archive_path = DATA_DIR / f"{file_stem}-archive.json"

    # Rotate: today's about-to-be-overwritten "current" becomes "prev",
    # but only if it's actually from a different day (don't demote today's
    # own data if the script gets run twice in one day).
    existing_current = _read_json(current_path, None)
    if existing_current is not None:
        existing_date = existing_current.get("date") if isinstance(existing_current, dict) else None
        if existing_date != snapshot_date:
            _write_json(prev_path, existing_current)

            archive = _read_json(archive_path, [])
            archive.append(existing_current)
            _write_json(archive_path, archive)

    _write_json(current_path, {"date": snapshot_date, "entries": entries})


# --- Main -------------------------------------------------------------

# Category key -> filename stem, matching the gocelest.com convention
# (e.g. conquest-current.json, conquest-prev.json, conquest-archive.json)
MAPLEIDLE_GAME_MODE_FILE_STEMS = {
    "conquest": "conquest",
    "world_boss": "world-boss",
    "training_ground": "training-ground",
    "guild_war": "guild-war",
    "guild_boss_battle": "guild-boss-battle",
}

# msidle.gg doesn't have a separate world_boss category, and guild_war is
# excluded (user-submitted data, see note above parse_msidle_page).
MSIDLE_GAME_MODE_FILE_STEMS = {
    "conquest": "msidle-conquest",
    "training_ground": "msidle-training-ground",
    "guild_boss_battle": "msidle-guild-boss-battle",
}

# Given mapleidle.gg's rate limiting has already been an issue for a single
# guild-page request, per-character pulls (one request per member) need a
# real gap between them -- this is 30x the request volume of the guild page
# alone in one run.
CHARACTER_FETCH_DELAY_SECONDS = 3
PLAYERS_DIR = DATA_DIR / "players"
PLAYERS_DIR.mkdir(parents=True, exist_ok=True)

MSIDLE_CHARACTER_PATH_TEMPLATE = "/characters/bera/{name}"
# msidle.gg character pages need 5 requests each (1 base + 4 deferred-prop
# partial reloads), vs 1 for mapleidle.gg -- pace both between sub-requests
# and between characters, even though msidle.gg hasn't shown rate-limit
# issues so far.
MSIDLE_CHARACTER_SUBREQUEST_DELAY_SECONDS = 0.5
MSIDLE_CHARACTER_FETCH_DELAY_SECONDS = 1.5


def run_mapleidle():
    print("=== mapleidle.gg ===")
    html = fetch_mapleidle_page()
    cache_raw_html(html, source="mapleidle")

    parsed = parse_guild_page(html)
    if not parsed["members"]:
        print(
            "WARNING: no members parsed. mapleidle.gg may have changed how "
            "it embeds guild data -- check the cached HTML in "
            f"{RAW_CACHE_DIR} and search for a known member name to see "
            "where it moved."
        )
        return

    print(f"Parsed {len(parsed['members'])} members")
    write_roster(parsed["members"], filename="roster.json")

    snapshot_date = datetime.date.today().isoformat()
    for mode_key, file_stem in MAPLEIDLE_GAME_MODE_FILE_STEMS.items():
        entries = parsed["scores"].get(mode_key, [])
        write_category(file_stem, entries, snapshot_date)
        print(f"  {file_stem}: {len(entries)} entries")

    run_mapleidle_characters(parsed["members"])


def run_mapleidle_characters(members: list):
    """Fetch each member's individual character page for rank cards,
    performance cards, and daily history. This is far more requests than
    the guild page alone (one per member instead of one total), so it's
    paced with a delay between calls and stops the whole batch on the
    first rate limit rather than continuing to hammer a throttled site."""
    print(f"\n=== mapleidle.gg character pages ({len(members)} members) ===")
    for i, member in enumerate(members):
        name = member.get("name")
        if not name:
            continue

        try:
            html = fetch_mapleidle_character_page(name)
        except requests.exceptions.HTTPError as e:
            if "429" in str(e):
                print(
                    f"Rate limited on character '{name}' -- stopping the "
                    f"rest of this batch ({len(members) - i} remaining) "
                    f"rather than continuing to hit a throttled site. "
                    f"Already-written player files are unaffected; rerun "
                    f"later to pick up the rest."
                )
                return
            print(f"  {name}: failed ({e}), skipping")
            continue

        parsed = parse_mapleidle_character_page(html)
        if not parsed["history"] and not parsed["ranks"]:
            print(f"  {name}: no data parsed, skipping write")
        else:
            _write_json(PLAYERS_DIR / f"{name}.json", parsed)
            print(f"  {name}: {len(parsed['history'])} history points, "
                  f"{len(parsed['ranks'])} rank cards, "
                  f"{len(parsed['performance'])} performance cards")

        if i < len(members) - 1:
            time.sleep(CHARACTER_FETCH_DELAY_SECONDS)


def run_msidle():
    print("=== msidle.gg ===")
    html = fetch_msidle_page()
    cache_raw_html(html, source="msidle")

    parsed = parse_msidle_page(html)
    if not parsed["members"]:
        print(
            "WARNING: no members parsed. msidle.gg may have changed how it "
            "embeds guild data -- check the cached HTML in "
            f"{RAW_CACHE_DIR} and confirm the data-page <script> tag is "
            "still structured the same way."
        )
        return

    print(f"Parsed {len(parsed['members'])} members")
    write_roster(parsed["members"], filename="msidle-roster.json")

    snapshot_date = datetime.date.today().isoformat()
    for mode_key, file_stem in MSIDLE_GAME_MODE_FILE_STEMS.items():
        entries = parsed["scores"].get(mode_key, [])
        write_category(file_stem, entries, snapshot_date)
        print(f"  {file_stem}: {len(entries)} entries")

    run_msidle_characters(parsed["members"])


def run_msidle_characters(members: list):
    """Fetch each member's msidle.gg character page. This is the backup
    source for player pages (mapleidle.gg is preferred when available since
    its data tends to be fresher) -- written to separate '-msidle' suffixed
    files so it never overwrites the mapleidle.gg version.

    Each character costs 5 requests here (1 base + 4 deferred-prop partial
    reloads), so this paces both between sub-requests and between
    characters, and stops the batch cleanly on the first rate limit rather
    than continuing to hit a throttled site."""
    print(f"\n=== msidle.gg character pages ({len(members)} members) ===")
    for i, member in enumerate(members):
        name = member.get("name")
        if not name:
            continue

        try:
            props = fetch_msidle_character(name)
        except requests.exceptions.HTTPError as e:
            if "429" in str(e):
                print(
                    f"Rate limited on character '{name}' -- stopping the "
                    f"rest of this batch ({len(members) - i} remaining) "
                    f"rather than continuing to hit a throttled site. "
                    f"Already-written player files are unaffected; rerun "
                    f"later to pick up the rest."
                )
                return
            print(f"  {name}: failed ({e}), skipping")
            continue
        except (ValueError, json.JSONDecodeError) as e:
            print(f"  {name}: failed to parse ({e}), skipping")
            continue

        parsed = parse_msidle_character_props(props)
        _write_json(PLAYERS_DIR / f"{name}-msidle.json", parsed)
        history_points = sum(len(v) for v in parsed["history"].values())
        print(f"  {name}: {len(parsed['ranks'])} rank entries, "
              f"{len(parsed['performance'])} performance entries, "
              f"{history_points} total history points")

        if i < len(members) - 1:
            time.sleep(MSIDLE_CHARACTER_FETCH_DELAY_SECONDS)


def main():
    try:
        run_mapleidle()
    except requests.exceptions.HTTPError as e:
        print(f"mapleidle.gg run failed, skipping: {e}")

    print()

    try:
        run_msidle()
    except requests.exceptions.HTTPError as e:
        print(f"msidle.gg run failed, skipping: {e}")

    print(f"\nDone. Files written under {DATA_DIR}/")


if __name__ == "__main__":
    main()
