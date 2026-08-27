/* ============================================================
   Freakmont — player page
   Normalizes two different per-character JSON shapes into one
   common structure before rendering, since mapleidle.gg and
   msidle.gg don't describe a character the same way:

   mapleidle.gg (primary):
     { ranks: {slug: {rank, total}},
       performance: {slug: {score, updated}},
       history: [{date, cpRaw, cpDisplay, level, globalRank}] }
     No name/class/level/cp block of its own -- that comes from
     the guild roster file instead.

   msidle.gg (fallback):
     { character: {name, class, level, cpRaw, cpDisplay, fame},
       ranks: {global|server|world|job: {rank, percentile}},
       performance: {conquest|training_ground|...: {score, percentile, updated}},
       scoreComparison: {guild_conquest|guild_training_ground|...: {vs_all_pct, vs_class_pct, date}},
       history: {conquest_history, training_ground_history, ...,
                 cp_history, level_history} }

   Category keys don't even agree with themselves within a single
   msidle file (performance.guild_boss_battle vs
   scoreComparison.guild_boss vs history.guild_boss_battle_history),
   so categories are matched by substring rather than exact key.
   ============================================================ */

const CATEGORY_DEFS = [
  { id: 'conquest', label: 'Guild Conquest', test: k => k.includes('conquest') },
  { id: 'world_boss', label: 'World Boss', test: k => k.includes('world_boss') || k.includes('worldboss') },
  { id: 'guild_war', label: 'Guild War', test: k => k.includes('war') },
  { id: 'guild_boss_battle', label: 'Guild Boss Battle', test: k => k.includes('boss') && !k.includes('world') },
  { id: 'training_ground', label: 'Training Ground', test: k => k.includes('training') },
];

function categoryIdFor(key) {
  const found = CATEGORY_DEFS.find(c => c.test(key.toLowerCase()));
  return found ? found.id : null;
}

/** Build the empty per-category skeleton so every known category
 * exists even if this particular character has no data for it. */
function emptyCategories() {
  const out = {};
  CATEGORY_DEFS.forEach(c => {
    out[c.id] = { label: c.label, score: null, updated: null, percentile: null, vsAll: null, vsClass: null, history: [] };
  });
  return out;
}

/** Normalize a mapleidle.gg character file. */
function normalizeMapleidle(raw, rosterEntry) {
  const ranks = Object.entries(raw.ranks || {}).map(([key, val]) => ({
    label: prettifyLabel(key),
    rank: val.rank,
    total: val.total,
    percentile: null,
  }));

  const categories = emptyCategories();
  Object.entries(raw.performance || {}).forEach(([key, val]) => {
    const id = categoryIdFor(key);
    if (!id) return;
    categories[id].score = val.score;
    categories[id].updated = resolveYearlessDate(val.updated, raw.scraped_at);
  });

  // mapleidle's history array is CP/level/global-rank/fame over time,
  // not per-category score history -- category tabs won't have charts
  // when this is the source, only current values.
  const history = raw.history || [];
  const cpHistory = history.map(h => ({ date: resolveYearlessDate(h.date, raw.scraped_at), cpRaw: h.cpRaw }));
  const levelHistory = history.map(h => ({ date: resolveYearlessDate(h.date, raw.scraped_at), level: h.level }));
  const globalRankHistory = history
    .filter(h => typeof h.globalRank === 'number')
    .map(h => ({ date: resolveYearlessDate(h.date, raw.scraped_at), globalRank: h.globalRank }));
  const fameHistory = history
    .filter(h => typeof h.fame === 'number')
    .map(h => ({ date: resolveYearlessDate(h.date, raw.scraped_at), fame: h.fame }));

  const latest = history[history.length - 1];

  return {
    identity: {
      name: rosterEntry?.name || null,
      class: rosterEntry?.class || null,
      level: latest?.level ?? rosterEntry?.level ?? null,
      cpRaw: latest?.cpRaw ?? rosterEntry?.cpRaw ?? null,
      cpDisplay: latest?.cpDisplay || rosterEntry?.cpDisplay || null,
      fame: latest?.fame ?? null,
    },
    ranks,
    categories,
    cpHistory,
    levelHistory,
    globalRankHistory,
    fameHistory,
    scrapedAt: raw.scraped_at,
  };
}

/** Normalize an msidle.gg character file. */
function normalizeMsidle(raw, rosterEntry) {
  const ch = raw.character || {};
  const ranks = Object.entries(raw.ranks || {}).map(([key, val]) => ({
    label: prettifyLabel(key),
    rank: val.rank,
    total: null,
    percentile: val.percentile,
  }));

  const categories = emptyCategories();
  Object.entries(raw.performance || {}).forEach(([key, val]) => {
    const id = categoryIdFor(key);
    if (!id) return;
    categories[id].score = val.score;
    categories[id].updated = val.updated;
    categories[id].percentile = val.percentile;
  });
  Object.entries(raw.scoreComparison || {}).forEach(([key, val]) => {
    const id = categoryIdFor(key);
    if (!id) return;
    categories[id].vsAll = val.vs_all_pct;
    categories[id].vsClass = val.vs_class_pct;
  });
  Object.entries(raw.history || {}).forEach(([key, arr]) => {
    if (key === 'cp_history' || key === 'level_history') return;
    const id = categoryIdFor(key);
    if (!id) return;
    categories[id].history = (arr || []).map(e => ({ date: e.date, score: e.score }));
  });

  const cpHistory = (raw.history?.cp_history || []).map(e => ({ date: e.date, cpRaw: e.cpRaw }));
  const levelHistory = (raw.history?.level_history || []).map(e => ({ date: e.date, level: e.level }));
  // msidle.gg doesn't track global rank or fame over time, only current
  // values (picked up in identity below) -- those two charts just won't
  // have data when this is the source.
  const globalRankHistory = [];
  const fameHistory = [];

  return {
    identity: {
      name: ch.name || rosterEntry?.name || null,
      class: ch.class || rosterEntry?.class || null,
      level: ch.level ?? rosterEntry?.level ?? null,
      cpRaw: ch.cpRaw ?? rosterEntry?.cpRaw ?? null,
      cpDisplay: ch.cpDisplay || rosterEntry?.cpDisplay || null,
      fame: ch.fame ?? null,
    },
    ranks,
    categories,
    cpHistory,
    levelHistory,
    globalRankHistory,
    fameHistory,
    scrapedAt: raw.scraped_at,
  };
}

/* -- Chart.js line chart, styled to match the parchment palette -- */
function drawLineChart(canvasId, points, { valueKey, formatValue, color, stepped = false, reverseAxis = false }) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (!points.length) return null;
  if (typeof Chart === 'undefined') {
    canvas.closest('.chart-wrap').innerHTML = '<div class="empty-state">Chart library failed to load.</div>';
    return null;
  }

  const ctx = canvas.getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => formatDate(p.date)),
      datasets: [{
        data: points.map(p => p[valueKey]),
        borderColor: color,
        backgroundColor: color + '22',
        pointRadius: 2.5,
        pointBackgroundColor: color,
        borderWidth: 2,
        tension: stepped ? 0 : 0.25,
        stepped: stepped ? 'before' : false,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => formatValue(ctx.parsed.y),
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#93897a', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
        },
        y: {
          reverse: reverseAxis,
          grid: { color: '#d8cbaa' },
          ticks: {
            color: '#93897a',
            font: { family: 'JetBrains Mono', size: 10 },
            callback: (val) => formatValue(val),
          },
        },
      },
    },
  });
}

async function initPlayerPage() {
  const params = new URLSearchParams(location.search);
  const name = params.get('name');

  const statusBadge = document.getElementById('source-badge');
  const updatedDate = document.getElementById('updated-date');

  const ranksData = await loadRanks();

  if (!name) {
    document.getElementById('player-root').innerHTML =
      '<div class="card"><div class="empty-state">No character specified. Go back to the guild page and pick a name.</div></div>';
    statusBadge.textContent = 'NO DATA';
    return;
  }

  // roster gives us guild-wide context: this member's identity as of
  // the last guild-page scrape, and their rank within Freakmont by CP.
  const rosterResult = await loadGuildFile('roster.json', 'msidle-roster.json');
  const roster = rosterResult.data || [];
  const rosterEntry = roster.find(m => m.name === name) || null;
  const sortedRoster = [...roster].sort((a, b) => (b.cpRaw || 0) - (a.cpRaw || 0));
  const guildRank = sortedRoster.findIndex(m => m.name === name) + 1;

  // player file: primary mapleidle.gg, fallback msidle.gg. Fetch both
  // (not primary-then-fallback) because mapleidle.gg's character page
  // doesn't expose per-category score history at all -- each category
  // card there is only a current value + "Updated <date>" (confirmed
  // via HAR inspection: no history array outside the CP chartData).
  // msidle.gg's per-player file does track category history, sparsely,
  // so when primary data is available we still pull msidle.gg's file
  // to backfill category charts it would otherwise be missing.
  const [primary, msidleRaw] = await Promise.all([
    tryFetchJSON(`${DATA_DIR}/players/${name}.json`),
    tryFetchJSON(`${DATA_DIR}/players/${name}-msidle.json`),
  ]);
  const raw = primary || msidleRaw;

  if (!raw && !rosterEntry) {
    document.getElementById('player-root').innerHTML =
      `<div class="card"><div class="empty-state">No data found for "${name}".</div></div>`;
    statusBadge.textContent = 'NO DATA';
    return;
  }

  statusBadge.textContent = 'INFO';

  const data = raw
    ? (primary ? normalizeMapleidle(primary, rosterEntry) : normalizeMsidle(msidleRaw, rosterEntry))
    : { identity: rosterEntry, ranks: [], categories: emptyCategories(), cpHistory: [], levelHistory: [], globalRankHistory: [], fameHistory: [], scrapedAt: null };

  // Backfill category history from msidle.gg wherever mapleidle.gg (the
  // current-value source) doesn't have any of its own for that category.
  if (primary && msidleRaw) {
    const msidleData = normalizeMsidle(msidleRaw, rosterEntry);
    Object.keys(data.categories).forEach(id => {
      const cat = data.categories[id];
      const msidleCat = msidleData.categories[id];
      if (!cat.history.length && msidleCat.history.length) {
        cat.history = msidleCat.history;
        cat.historyFromMsidle = true;
      }
    });
  }

  updatedDate.textContent = data.scrapedAt ? `Updated ${formatDate(data.scrapedAt)}` : '';
  const sidebarUpdated = document.getElementById('sidebar-updated');
  if (sidebarUpdated) sidebarUpdated.textContent = data.scrapedAt ? `🕐 ${formatDate(data.scrapedAt)}` : '🕐 —';

  renderIdentity(data, guildRank, roster.length, ranksData[name]);
  renderRanks(data.ranks);
  renderHistoryCharts(data);
  renderCategoryTabs(data.categories);
}

function renderIdentity(data, guildRank, guildSize, rankId) {
  const { name, class: cls, level, cpDisplay, cpRaw, fame } = data.identity || {};
  document.title = `${name || 'Player'} — Freakmont`;
  document.getElementById('player-name').textContent = name || 'Unknown';
  document.getElementById('player-cp').textContent = cpDisplay || formatCP(cpRaw);

  const pills = document.getElementById('player-pills');
  const pillList = [];
  if (rankId) pillList.push(rankBadge(rankId));
  if (cls) pillList.push(`<span class="pill">${cls}</span>`);
  if (level) pillList.push(`<span class="pill">Level ${level}</span>`);
  if (guildRank > 0) pillList.push(`<span class="pill">#${guildRank} in guild of ${guildSize}</span>`);
  if (typeof fame === 'number') pillList.push(`<span class="pill pill-fame">♥ ${formatScore(fame)}</span>`);
  pills.innerHTML = pillList.join('');
}

function renderRanks(ranks) {
  const grid = document.getElementById('rank-grid');
  const card = document.getElementById('rank-card-section');
  if (!ranks.length) { card.style.display = 'none'; return; }
  grid.innerHTML = ranks.map(r => `
    <div class="rank-card">
      <div class="label">${r.label}</div>
      <div class="rank">#${formatScore(r.rank)}</div>
      <div class="of">${r.total ? `of ${formatScore(r.total)}` : (r.percentile != null ? `top ${r.percentile}%` : '')}</div>
    </div>
  `).join('');
}

/** Delta badge shown in each history card's header, e.g. "+146.3%" for
 * CP or "+42" for Global Rank. `higherIsBetter=false` (Global Rank only)
 * flips the sign so an improving (falling) rank still shows green/+. */
function historyDelta(points, valueKey, { asPercent = false, higherIsBetter = true } = {}) {
  const vals = points.map(p => p[valueKey]).filter(v => typeof v === 'number');
  if (vals.length < 2) return null;
  const first = vals[0];
  const last = vals[vals.length - 1];
  const raw = higherIsBetter ? (last - first) : (first - last);
  const pos = raw >= 0;
  const text = asPercent
    ? formatPct(first !== 0 ? (raw / Math.abs(first)) * 100 : 0)
    : `${pos ? '+' : ''}${Math.round(raw).toLocaleString('en-US')}`;
  return { text, pos };
}

function renderHistoryCharts(data) {
  const section = document.getElementById('history-section');
  const { cpHistory, levelHistory, globalRankHistory, fameHistory } = data;

  if (!cpHistory.length) {
    section.innerHTML = '<h2 class="section-title">History</h2><div class="empty-state">No history yet — check back after a few daily scrapes.</div>';
    return;
  }

  const panels = [
    { id: 'cp', title: 'Combat Power', points: cpHistory, valueKey: 'cpRaw', formatValue: formatCP, color: '#2f6fa8', delta: historyDelta(cpHistory, 'cpRaw', { asPercent: true }) },
    { id: 'rank', title: 'Global Rank', points: globalRankHistory, valueKey: 'globalRank', formatValue: (v) => `#${formatScore(v)}`, color: '#b8863b', reverseAxis: true, delta: historyDelta(globalRankHistory, 'globalRank', { higherIsBetter: false }) },
    { id: 'level', title: 'Level', points: levelHistory, valueKey: 'level', formatValue: (v) => `${v}`, color: '#5f7d4f', stepped: true, delta: historyDelta(levelHistory, 'level') },
    { id: 'fame', title: 'Fame', points: fameHistory, valueKey: 'fame', formatValue: formatScore, color: '#a4485c', delta: historyDelta(fameHistory, 'fame') },
  ];

  section.innerHTML = `
    <h2 class="section-title">History</h2>
    <div class="history-grid">
      ${panels.map(p => `
        <div class="history-chart-card">
          <div class="head">
            <span class="title">${p.title}</span>
            ${p.delta ? `<span class="delta ${p.delta.pos ? 'pos' : 'neg'}">${p.delta.text}</span>` : ''}
          </div>
          ${p.points.length
            ? `<div class="chart-wrap"><canvas id="hist-chart-${p.id}"></canvas></div>`
            : '<div class="empty-state">No history for this source yet.</div>'}
        </div>`).join('')}
    </div>
    <div class="level-log" id="level-log"></div>
  `;

  panels.forEach(p => {
    if (!p.points.length) return;
    drawLineChart(`hist-chart-${p.id}`, p.points, {
      valueKey: p.valueKey,
      formatValue: p.formatValue,
      color: p.color,
      stepped: !!p.stepped,
      reverseAxis: !!p.reverseAxis,
    });
  });

  // level-up log underneath the grid, since the step chart alone
  // doesn't show exact dates clearly at a glance
  const levelUps = [];
  let lastLevel = null;
  levelHistory.forEach(e => {
    if (e.level !== lastLevel) {
      levelUps.push(e);
      lastLevel = e.level;
    }
  });
  const log = document.getElementById('level-log');
  if (levelUps.length) {
    log.innerHTML = 'Level ups: ' + levelUps.map(e => `<span>${e.level}</span> (${formatDate(e.date)})`).join(' · ');
  }
}

function renderCategoryTabs(categories) {
  const tabsEl = document.getElementById('category-tabs');
  const panelsEl = document.getElementById('category-panels');
  const ids = CATEGORY_DEFS.map(c => c.id).filter(id => categories[id].score !== null || categories[id].history.length);

  if (!ids.length) {
    document.getElementById('category-section').innerHTML =
      '<h2 class="section-title">Category Performance</h2><div class="empty-state">No category performance recorded for this character yet.</div>';
    return;
  }

  tabsEl.innerHTML = ids.map((id, i) =>
    `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-cat="${id}">${categories[id].label}</button>`
  ).join('');

  panelsEl.innerHTML = ids.map((id, i) => {
    const c = categories[id];
    const chips = [];
    const vsAllStr = formatPct(c.vsAll);
    const vsClassStr = formatPct(c.vsClass);
    if (vsAllStr) chips.push(`<span class="comparison-chip ${c.vsAll >= 0 ? 'pos' : 'neg'}">${vsAllStr} vs guild avg</span>`);
    if (vsClassStr) chips.push(`<span class="comparison-chip ${c.vsClass >= 0 ? 'pos' : 'neg'}">${vsClassStr} vs class avg</span>`);
    if (c.percentile != null) chips.push(`<span class="comparison-chip">top ${c.percentile}%</span>`);

    return `
      <div class="tab-panel ${i === 0 ? 'active' : ''}" id="cat-panel-${id}" data-cat-panel="${id}">
        <div class="category-summary">
          <div class="score">${c.score !== null ? formatBig(c.score) : '—'}</div>
          <div class="updated">${c.updated ? `Updated ${formatDate(c.updated)}` : 'No recent activity'}</div>
        </div>
        ${chips.length ? `<div class="comparison-row">${chips.join('')}</div>` : ''}
        ${c.history.length
          ? `<div class="chart-wrap"><canvas id="chart-${id}"></canvas></div>
             ${c.historyFromMsidle ? '<p class="chart-source-note">Trend from msidle.gg -- current value above is from mapleidle.gg and may not match the chart\'s latest point.</p>' : ''}`
          : '<div class="empty-state">No history chart for this source yet.</div>'}
      </div>
    `;
  }).join('');

  tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      panelsEl.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`cat-panel-${btn.dataset.cat}`).classList.add('active');
    });
  });

  // draw charts for whichever categories have history
  ids.forEach(id => {
    const c = categories[id];
    if (c.history.length) {
      drawLineChart(`chart-${id}`, c.history, {
        valueKey: 'score',
        formatValue: formatBig,
        color: '#5f7d4f',
      });
    }
  });
}

initPlayerPage();
