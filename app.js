/* ============================================================
   Freakmont — shared data helpers
   Mirrors the source-preference logic from scrape_guild.py:
   mapleidle.gg files (unprefixed) are primary, msidle.gg files
   (prefixed "msidle-") are the fallback when primary is
   missing or hasn't been produced yet.
   ============================================================ */

const DATA_DIR = 'data/freakmont';

/** Fetch JSON, returning null instead of throwing on failure. */
async function tryFetchJSON(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/**
 * Load a guild-level data file, preferring the primary
 * (mapleidle.gg) filename and falling back to the msidle.gg
 * equivalent. Returns { data, source } where source is
 * 'primary' | 'fallback' | null.
 */
async function loadGuildFile(primaryName, fallbackName) {
  const primary = await tryFetchJSON(`${DATA_DIR}/${primaryName}`);
  if (primary) return { data: primary, source: 'primary' };
  const fallback = await tryFetchJSON(`${DATA_DIR}/${fallbackName}`);
  if (fallback) return { data: fallback, source: 'fallback' };
  return { data: null, source: null };
}

/* -- CP display formatting, ported from format_cp() in scrape_guild.py -- */
const CP_SUFFIXES = ['', 'K', 'M', 'B', 'T'];

function cpSuffixForPower(p) {
  if (p < CP_SUFFIXES.length) return CP_SUFFIXES[p];
  const j = p - CP_SUFFIXES.length;
  const first = String.fromCharCode(65 + Math.floor(j / 26));
  const second = String.fromCharCode(65 + (j % 26));
  return first + second;
}

function formatCP(nInput) {
  if (nInput === null || nInput === undefined) return '—';
  let n = BigInt(Math.round(nInput));
  if (n === 0n) return '0';

  let p = 0;
  while (1000n ** BigInt(p + 1) <= n) p += 1;

  const top = n / (1000n ** BigInt(p));
  const remainder = n % (1000n ** BigInt(p));

  if (p === 0) return top.toString();

  const nextP = p - 1;
  const nextVal = remainder / (1000n ** BigInt(nextP));
  const topStr = `${top}${cpSuffixForPower(p)}`;
  if (nextVal === 0n) return topStr;
  return `${topStr} ${nextVal}${cpSuffixForPower(nextP)}`;
}

function formatScore(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

/* -- basic stats -- */
function median(sortedNums) {
  const n = sortedNums.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

function mean(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/* -- misc formatting helpers, shared by index.html and player.html -- */

/** "training_ground" -> "Training Ground" */
function prettifyLabel(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/\brank\b/gi, '')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** All category scores (conquest, boss battle, training ground, guild
 * war, world boss, etc.) use the same CP-style suffix notation as
 * Combat Power, regardless of magnitude -- kept as its own name since
 * "score" and "CP" are conceptually different fields that happen to
 * format the same way. */
function formatBig(n) {
  return formatCP(n);
}

function formatPct(n, decimals = 1) {
  if (n === null || n === undefined) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(decimals)}%`;
}

/** Short relative-ish date, e.g. "2026-08-17T04:31:54+00:00" -> "Aug 17, 2026" */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** mapleidle.gg's short dates ("7/26", "Aug 23") never include a year --
 * JS's Date parser silently defaults an omitted year to 2001, which is
 * why unpatched dates render as e.g. "Jul 26, 2001". This reconstructs
 * the real year from a reference timestamp (the record's own scraped_at,
 * since every date in a mapleidle.gg history/performance block is on or
 * before the moment it was scraped): guess the reference year, then
 * roll back a year if that guess would land in the future -- handles a
 * scrape early in the year referencing data from the previous Dec. Full
 * ISO strings (already containing a 4-digit year) pass through untouched. */
function resolveYearlessDate(dateStr, referenceDate) {
  if (!dateStr || /\d{4}/.test(dateStr)) return dateStr;
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate || Date.now());
  if (isNaN(ref)) return dateStr;
  const guess = new Date(`${dateStr} ${ref.getFullYear()}`);
  if (isNaN(guess)) return dateStr;
  if (guess.getTime() - ref.getTime() > 24 * 60 * 60 * 1000) {
    guess.setFullYear(ref.getFullYear() - 1);
  }
  return guess.toISOString();
}

/* -- shared sidebar: player search + "/" shortcut -- */
/* -- guild rank/title tags --
 * Master and Vice Master are seniority roles; the rest are parallel
 * tags with no ranking between them. Maintained by hand in
 * data/freakmont/ranks.json, not scraped. */
const RANK_DEFS = {
  master: { label: 'Master', cls: 'rank-master' },
  vice_master: { label: 'Vice Master', cls: 'rank-vice-master' },
  elite_freak: { label: 'EliteFreak', cls: 'rank-elite-freak' },
  guild_freak: { label: 'GuildFreak', cls: 'rank-guild-freak' },
  day1_fweaks: { label: 'Day1Fweaks', cls: 'rank-day1-fweaks' },
};

async function loadRanks() {
  const data = await tryFetchJSON(`${DATA_DIR}/ranks.json`);
  return (data && data.ranks) || {};
}

function rankBadge(rankId) {
  const def = RANK_DEFS[rankId];
  if (!def) return '';
  return `<span class="rank-badge ${def.cls}">${def.label}</span>`;
}

async function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('nav-toggle');
  const overlay = document.getElementById('sidebar-overlay');

  if (sidebar && toggle && overlay) {
    const closeNav = () => sidebar.classList.remove('open');
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    overlay.addEventListener('click', closeNav);
    // close after picking a nav link, so the drawer doesn't stay open
    // on the destination page
    sidebar.querySelectorAll('a').forEach(a => a.addEventListener('click', closeNav));
  }

  const input = document.getElementById('sidebar-search');
  if (!input) return;

  // "/" focuses the search box from anywhere, unless already typing
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/') return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    ev.preventDefault();
    input.focus();
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const val = input.value.trim();
    if (!val) return;
    location.href = `player.html?name=${encodeURIComponent(val)}`;
  });

  // populate the datalist for autocomplete once the roster loads
  const { data: roster } = await loadGuildFile('roster.json', 'msidle-roster.json');
  const list = document.getElementById('player-datalist');
  if (roster && list) {
    list.innerHTML = roster
      .slice().sort((a, b) => a.name.localeCompare(b.name))
      .map(m => `<option value="${m.name}"></option>`).join('');
  }
}
