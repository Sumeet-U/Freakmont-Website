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
  { id: 'training_ground', label: 'Training Ground', test: k => k.includes('training') },
  { id: 'guild_boss_battle', label: 'Guild Boss Battle', test: k => k.includes('boss') && !k.includes('world') },
  { id: 'world_boss', label: 'World Boss', test: k => k.includes('world_boss') || k.includes('worldboss') },
  { id: 'guild_war', label: 'Guild War', test: k => k.includes('war') },
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
    categories[id].updated = val.updated;
  });

  // mapleidle's history array is CP/level/global-rank over time, not
  // per-category score history -- category tabs won't have charts
  // when this is the source, only current values.
  const history = raw.history || [];
  const cpHistory = history.map(h => ({ date: h.date, cpRaw: h.cpRaw }));
  const levelHistory = history.map(h => ({ date: h.date, level: h.level }));

  const latest = history[history.length - 1];

  return {
    identity: {
      name: rosterEntry?.name || null,
      class: rosterEntry?.class || null,
      level: latest?.level ?? rosterEntry?.level ?? null,
      cpRaw: latest?.cpRaw ?? rosterEntry?.cpRaw ?? null,
      cpDisplay: latest?.cpDisplay || rosterEntry?.cpDisplay || null,
      fame: null,
    },
    ranks,
    categories,
    cpHistory,
    levelHistory,
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
    scrapedAt: raw.scraped_at,
  };
}

/* -- Chart.js line chart, styled to match the parchment palette -- */
function drawLineChart(canvasId, points, { valueKey, formatValue, color }) {
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
        tension: 0.25,
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

  // player file: primary mapleidle.gg, fallback msidle.gg
  const primary = await tryFetchJSON(`${DATA_DIR}/players/${name}.json`);
  const source = primary ? 'primary' : 'fallback';
  const fallback = primary ? null : await tryFetchJSON(`${DATA_DIR}/players/${name}-msidle.json`);
  const raw = primary || fallback;

  if (!raw && !rosterEntry) {
    document.getElementById('player-root').innerHTML =
      `<div class="card"><div class="empty-state">No data found for "${name}".</div></div>`;
    statusBadge.textContent = 'NO DATA';
    return;
  }

  statusBadge.textContent = 'INFO';

  const data = raw
    ? (primary ? normalizeMapleidle(raw, rosterEntry) : normalizeMsidle(raw, rosterEntry))
    : { identity: rosterEntry, ranks: [], categories: emptyCategories(), cpHistory: [], levelHistory: [], scrapedAt: null };

  updatedDate.textContent = data.scrapedAt ? `Updated ${formatDate(data.scrapedAt)}` : '';
  const sidebarUpdated = document.getElementById('sidebar-updated');
  if (sidebarUpdated) sidebarUpdated.textContent = data.scrapedAt ? `🕐 ${formatDate(data.scrapedAt)}` : '🕐 —';

  renderIdentity(data, guildRank, roster.length, ranksData[name]);
  renderRanks(data.ranks);
  renderCpChart(data.cpHistory, data.levelHistory);
  renderCategoryTabs(data.categories);
}

function renderIdentity(data, guildRank, guildSize, rankId) {
  const { name, class: cls, level, cpDisplay, cpRaw } = data.identity || {};
  document.title = `${name || 'Player'} — Freakmont`;
  document.getElementById('player-name').textContent = name || 'Unknown';
  document.getElementById('player-cp').textContent = cpDisplay || formatCP(cpRaw);

  const pills = document.getElementById('player-pills');
  const pillList = [];
  if (rankId) pillList.push(rankBadge(rankId));
  if (cls) pillList.push(`<span class="pill">${cls}</span>`);
  if (level) pillList.push(`<span class="pill">Level ${level}</span>`);
  if (guildRank > 0) pillList.push(`<span class="pill">#${guildRank} in guild of ${guildSize}</span>`);
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

function renderCpChart(cpHistory, levelHistory) {
  const section = document.getElementById('cp-chart-section');
  if (!cpHistory.length) {
    section.innerHTML = '<h2 class="section-title">CP Over Time</h2><div class="empty-state">No history yet — check back after a few daily scrapes.</div>';
    return;
  }
  drawLineChart('cp-chart', cpHistory, {
    valueKey: 'cpRaw',
    formatValue: formatCP,
    color: '#2f6fa8',
  });

  // level-up log underneath the chart, since level rarely changes
  // and doesn't need its own chart
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
          ? `<div class="chart-wrap"><canvas id="chart-${id}"></canvas></div>`
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
