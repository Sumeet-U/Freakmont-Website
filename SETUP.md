# Getting Freakmont's site live

Everything in this folder is meant to become one GitHub repo. The scraper
writes into `data/freakmont/`, the site reads from the same folder, and a
GitHub Actions workflow runs the scraper daily and commits whatever
changed. Once that's pushed, GitHub Pages (or Cloudflare Pages) serves the
site straight from the repo -- no server to run yourself.

## 1. Create the repo

1. Create a new repo on GitHub (public is simplest and free for Pages;
   private works too but needs a paid plan for Pages).
2. Push everything in this folder to it, preserving the structure --
   `index.html`, `player.html`, `scrape_guild.py`, `data/`, `assets/`,
   `.github/workflows/scrape.yml`, all at the repo root.

```bash
cd freakmont-site
git init
git add .
git commit -m "Initial site + scraper"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

No secrets or API keys to configure -- the scraper only reads public
pages with a plain `requests.get()`, so the default `GITHUB_TOKEN` GitHub
Actions already provides is all it needs (that's what lets the workflow
commit the daily data back to the repo).

## 2. Check the Actions permission

GitHub Actions' default token is sometimes read-only depending on your
account/org settings. If the workflow's push step fails with a permission
error the first time it runs:

**Settings → Actions → General → Workflow permissions** → select
**"Read and write permissions"** → Save.

## 3. Turn on hosting

Pick one -- both are free and auto-deploy on every push to `main`,
including the daily scrape's commits.

**GitHub Pages (simplest, no third-party account):**
**Settings → Pages → Source** → "Deploy from a branch" → branch `main`,
folder `/ (root)` → Save. Your site will be at
`https://<you>.github.io/<repo>/`.

**Cloudflare Pages (alternative, gives a custom-domain-friendly setup and
a faster global CDN):** cloudflare.com → Pages → "Connect to Git" → pick
this repo → build command: none, output directory: `/` → Deploy.

## 4. Get real data flowing

The repo as bundled only has the msidle.gg sample data from this chat.
Two ways to get everything current:

- **Wait for the schedule.** The workflow runs daily at 09:17 UTC (edit
  the `cron` line in `.github/workflows/scrape.yml` to change the time --
  keep a non-zero minute so it doesn't queue behind everyone else's
  on-the-hour jobs).
- **Trigger it now.** Repo → Actions tab → "Daily Guild Scrape" →
  "Run workflow". Takes a few minutes (character pages are paced with
  delays on purpose, per the rate-limit notes in the script).

Either way, once it completes, `data/freakmont/` fills in with mapleidle.gg's
roster/category files and all 30 members' player JSON on both sources,
and the site picks all of it up automatically -- the frontend already
prefers mapleidle.gg and falls back to msidle.gg with zero code changes
needed.

## 5. Keep running it locally too, if useful

Nothing about automating this retires the manual `python scrape_guild.py`
workflow from your machine -- it's the same script either way. Handy if
you want to force a same-day refresh, or check the mapleidle.gg rate
limit status without waiting on the schedule.

## Notes on the schedule

- Runs once a day, matching the "once-daily" cadence both site
  maintainers agreed to.
- If mapleidle.gg 429s partway through, the run still commits whatever
  msidle.gg and the partial mapleidle.gg data it got -- `main()` wraps
  each source's run separately, so one failing doesn't block the other.
- Empty runs (nothing changed since yesterday) don't create empty commits
  -- the workflow checks `git diff --cached --quiet` first.
