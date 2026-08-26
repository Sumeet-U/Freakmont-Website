# Freakmont

A stats dashboard for **Freakmont**, a MapleStory Idle guild on Bera 5.
Guild-wide rankings, CP distribution, category leaderboards, and
per-player pages with rank/CP history — built the same way
[gocelest.com](https://gocelest.com) is: flat JSON files + a static
frontend, no backend or database, updated by a scheduled scrape instead
of user logins.

## How it works

```
scrape_guild.py  →  data/freakmont/*.json  →  index.html / player.html
     (daily,           (flat files,              (fetches the JSON,
    GitHub Action)    committed to the repo)     renders client-side)
```

- **`scrape_guild.py`** pulls the guild roster and per-player stats from
  two sources.
- **`.github/workflows/scrape.yml`** runs that script once a day and
  commits whatever changed in `data/freakmont/`.
- **`index.html`** / **`player.html`** are plain HTML/CSS/JS — no build
  step, no framework. They fetch the JSON directly and render tables,
  charts, and leaderboards in the browser.

See [`SETUP.md`](./SETUP.md) for how to get this running from scratch —
creating the repo, turning on the scheduled scrape, and hosting.

## Structure

```
index.html              Guild home page: rankings, CP distribution,
                         rank distribution, Punch Score, category tabs
player.html              Per-player page (?name=CharacterName)
app.js / player.js       Shared logic + player-page-specific logic
styles.css                Shared visual system
assets/guild-logo.png     Guild crest (swap this file to change it)
data/freakmont/
  roster.json              mapleidle.gg roster (primary)
  msidle-roster.json        msidle.gg roster (fallback)
  *-current.json            Per-category leaderboards (conquest, guild
                             boss battle, training ground), each source
  ranks.json                 Guild rank/title tags -- hand-maintained,
                             never touched by the scraper
  players/<name>.json        Per-player detail, mapleidle.gg
  players/<name>-msidle.json Per-player detail, msidle.gg
scrape_guild.py            The scraper
```

## Guild ranks

`data/freakmont/ranks.json` maps character name → rank tag (Master,
Vice Master, EliteFreak, GuildFreak, Day1Fweaks). It's a plain hand-edited
file, not scraped data — update it directly whenever someone is promoted
or demoted; the daily scrape never writes to it.

## Credits

Visual design and site structure closely follow
[gocelest.com](https://gocelest.com) (guild: Celest).
