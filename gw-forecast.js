/* ============================================================
   Freakmont — Guild War Forecast page
   Reads data/freakmont/gw-forecast.json (built by
   scrape_gw_forecast.py) and data/freakmont/gw-opponents.json
   (hand-maintained matchup config) and renders the standings,
   our-roster projection, and pooled leaderboard.
   ============================================================ */

const LEADERBOARD_COLLAPSED_COUNT = 25;

(async function () {
  initSidebar();

  const statusBadge = document.getElementById('source-badge');
  const updatedDate = document.getElementById('updated-date');

  const opponentsConfig = await tryFetchJSON(`${DATA_DIR}/gw-opponents.json`);
  const forecast = await tryFetchJSON(`${DATA_DIR}/gw-forecast.json`);

  statusBadge.textContent = forecast ? 'INFO' : 'NO DATA';
  updatedDate.textContent = forecast ? `Updated ${forecast.date}` : '';
  document.getElementById('sidebar-updated').textContent = forecast ? `🕐 ${forecast.date}` : '🕐 —';
  document.getElementById('standings-updated').textContent = forecast ? `as of ${forecast.date}` : '—';

  renderMatchupPills(opponentsConfig, forecast);

  if (!forecast || !forecast.guilds || !forecast.guilds.length) {
    const emptyMsg = opponentsConfig
      ? 'Opponents are set, but no forecast has been generated yet — run scrape_gw_forecast.py to build it.'
      : 'No Guild War matchup configured yet — fill in data/freakmont/gw-opponents.json with this week\'s 4 opponent guilds, then run scrape_gw_forecast.py.';
    document.getElementById('gw-standings-list').innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
    document.getElementById('tbody-our-members').innerHTML = `<tr><td colspan="5" class="empty-state">${emptyMsg}</td></tr>`;
    document.getElementById('tbody-leaderboard').innerHTML = `<tr><td colspan="5" class="empty-state">${emptyMsg}</td></tr>`;
    return;
  }

  renderStandings(forecast.guilds);
  renderOurMembers(forecast.leaderboard);
  renderLeaderboard(forecast.leaderboard);

  function renderMatchupPills(config, forecastData) {
    const container = document.getElementById('matchup-pills');
    const guildNames = forecastData && forecastData.guilds && forecastData.guilds.length
      ? forecastData.guilds.map(g => ({ name: g.name, isUs: g.isUs }))
      : (config && config.opponents
          ? [{ name: 'Freakmont', isUs: true }, ...config.opponents.map(name => ({ name, isUs: false }))]
          : null);

    if (!guildNames) {
      container.innerHTML = '<span class="pill">No matchup set</span>';
      return;
    }

    const weekLabel = config && config.week_of ? `Week of ${config.week_of}` : null;
    container.innerHTML =
      (weekLabel ? `<span class="pill">${weekLabel}</span>` : '') +
      guildNames.map(g => `<span class="pill${g.isUs ? ' pill-us' : ''}">${g.name}</span>`).join('');
  }

  function renderStandings(guilds) {
    const list = document.getElementById('gw-standings-list');
    const maxPoints = Math.max(...guilds.map(g => g.totalPoints || 0), 1);
    list.innerHTML = guilds.map(g => {
      const pct = Math.max(2, Math.round(((g.totalPoints || 0) / maxPoints) * 100));
      return `
        <div class="gw-standings-row${g.isUs ? ' is-us' : ''}">
          <div class="rank">#${g.projectedRank}</div>
          <div class="who">
            <span class="name">${g.name}${g.isUs ? ' ★' : ''}</span>
            <span class="sub">${g.participantCount} scored / ${g.memberCount} members</span>
          </div>
          <div class="gw-standings-track"><div class="gw-standings-fill" style="width:${pct}%"></div></div>
          <div class="pts">${formatScore(g.totalPoints)}</div>
        </div>`;
    }).join('');
  }

  function renderOurMembers(leaderboard) {
    const tbody = document.getElementById('tbody-our-members');
    const ours = leaderboard.filter(r => r.isUs).sort((a, b) => a.rank - b.rank);
    if (!ours.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No Freakmont members have a recorded Guild War score yet.</td></tr>';
      return;
    }
    tbody.innerHTML = ours.map(r => {
      const medalClass = r.rank === 1 ? 'medal-1' : r.rank === 2 ? 'medal-2' : r.rank === 3 ? 'medal-3' : '';
      return `<tr>
        <td class="rank ${medalClass}">${r.rank}</td>
        <td class="name"><a href="player.html?name=${encodeURIComponent(r.name)}">${r.name}</a></td>
        <td class="class">${r.class || '—'}</td>
        <td class="num cp">${formatBig(r.score)}</td>
        <td class="num">${formatScore(r.points)}</td>
      </tr>`;
    }).join('');
  }

  function renderLeaderboard(leaderboard) {
    document.getElementById('leaderboard-count').textContent = leaderboard.length;
    const tbody = document.getElementById('tbody-leaderboard');
    const showMoreBtn = document.getElementById('leaderboard-show-more');

    const rowHtml = (r) => {
      const medalClass = r.rank === 1 ? 'medal-1' : r.rank === 2 ? 'medal-2' : r.rank === 3 ? 'medal-3' : '';
      const nameCell = r.isUs
        ? `<a href="player.html?name=${encodeURIComponent(r.name)}">${r.name}</a>`
        : r.name;
      return `<tr class="${r.isUs ? 'is-us' : ''}">
        <td class="rank ${medalClass}">${r.rank}</td>
        <td class="name">${nameCell}</td>
        <td class="class${r.isUs ? ' is-us-guild' : ''}">${r.guild}${r.isUs ? ' ★' : ''}</td>
        <td class="num cp">${formatBig(r.score)}</td>
        <td class="num">${formatScore(r.points)}</td>
      </tr>`;
    };

    if (leaderboard.length <= LEADERBOARD_COLLAPSED_COUNT) {
      tbody.innerHTML = leaderboard.map(rowHtml).join('');
      showMoreBtn.style.display = 'none';
      return;
    }

    tbody.innerHTML = leaderboard.slice(0, LEADERBOARD_COLLAPSED_COUNT).map(rowHtml).join('');
    showMoreBtn.style.display = 'block';
    showMoreBtn.textContent = `Show full leaderboard (${leaderboard.length})`;
    showMoreBtn.addEventListener('click', () => {
      tbody.innerHTML = leaderboard.map(rowHtml).join('');
      showMoreBtn.remove();
    });
  }
})();
