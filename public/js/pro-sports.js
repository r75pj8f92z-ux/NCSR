// Pro Sports: Carolina Panthers, Charlotte Hornets, Carolina Hurricanes.
// Real ESPN data throughout. NC Sports Report has no newsroom of its own yet, so the news feed
// aggregates and categorizes ESPN's own reporting with attribution and links out, rather than
// inventing articles, quotes or stats. See README.md.

const TEAM_ORDER = ['panthers', 'hornets', 'hurricanes'];
const LEAGUE_LABEL = { nfl: 'NFL', nba: 'NBA', nhl: 'NHL' };
const CATEGORY_ORDER = ['Game Recap', 'Game Preview', 'Injury Update', 'Transactions', 'Draft', 'Analysis', 'Team News', 'League News'];

const pro = { data: null, fetchedAt: 0, instances: new Set(), timer: null };
const SITE_TITLE = 'North Carolina Sports Report';
function setTitle(parts) { document.title = [...parts, 'Pro Sports', SITE_TITLE].filter(Boolean).join(' | '); }

// ---------- small DOM + fetch helpers (mirrors app.js; kept local so this module stands alone) ----------

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function apiGet(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

async function loadPro(force = false) {
  if (!force && pro.data && Date.now() - pro.fetchedAt < 20000) return pro.data;
  pro.data = await apiGet('/api/pro');
  pro.fetchedAt = Date.now();
  return pro.data;
}

// ---------- formatting ----------

const etTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
const etDay = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const etDayTime = (iso) => `${etDay(iso)} · ${etTime(iso)}`;
const timeAgo = (iso) => {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return etDay(iso);
};
const scoreLine = (game) => (game.score?.us != null && game.score?.them != null ? `${game.score.us}–${game.score.them}` : null);

function gameStatusLabel(game) {
  if (!game) return null;
  if (game.status === 'live') return 'LIVE';
  if (game.status === 'final') return 'FINAL';
  if (game.status === 'postponed') return 'POSTPONED';
  return 'UPCOMING';
}

// ---------- fallback art: no stock photos, no fabricated game photography ----------

function teamMonogram(team, extraClass = '') {
  return h('div', { class: `pro-mono ${extraClass}`, style: `--c:${team.color}; --c2:${team.colorDark || team.color}`, 'aria-hidden': 'true' },
    h('span', {}, team.short.slice(0, 1)));
}

function teamLogo(team, size = 28) {
  if (!team.logo) return teamMonogram(team);
  const img = h('img', { src: team.logo, alt: `${team.name} logo`, width: String(size), height: String(size), loading: 'lazy', class: 'pro-logo-img' });
  img.addEventListener('error', () => img.replaceWith(teamMonogram(team)), { once: true });
  return img;
}

// ---------- reusable cards (design-system section 7) ----------

function teamPill(team) {
  return h('a', { class: 'pro-pill', href: `#/pro-sports/${team.key}`, style: `--c:${team.color}` }, team.short);
}

function categoryPill(category) {
  return h('span', { class: 'pro-cat' }, category);
}

// One card builder, three sizes, so the feed, hub pages and homepage spotlight all share markup.
function articleCard(article, team, size = 'standard') {
  const media = article.image
    ? (() => {
        const img = h('img', { src: article.image, alt: article.imageCaption || article.headline, loading: size === 'featured' ? 'eager' : 'lazy', class: 'pro-card-img' });
        img.addEventListener('error', () => img.replaceWith(teamMonogram(team, 'pro-mono-fill')), { once: true });
        return img;
      })()
    : teamMonogram(team, 'pro-mono-fill');

  const meta = h('div', { class: 'pro-card-meta' },
    teamPill(team), categoryPill(article.category),
    h('span', { class: 'pro-dot' }, '·'),
    h('time', { datetime: article.published || '' }, article.published ? timeAgo(article.published) : ''));

  const link = h('a', { class: 'pro-card-link', href: article.url || '#', target: '_blank', rel: 'noopener noreferrer' },
    h('h3', { class: 'pro-card-head' }, article.headline));

  const card = h('article', { class: `pro-card pro-card--${size}` },
    h('div', { class: 'pro-card-media' }, media),
    h('div', { class: 'pro-card-body' },
      meta, link,
      size !== 'compact' && article.description ? h('p', { class: 'pro-card-dek' }, article.description) : null,
      h('span', { class: 'pro-card-source' }, 'Reporting by ESPN ↗')));
  return card;
}

function breakingBanner(article, team) {
  if (!article) return null;
  return h('div', { class: 'pro-breaking', style: `--c:${team.color}` },
    h('span', { class: 'pro-breaking-tag' }, 'Breaking News'),
    teamPill(team),
    h('a', { class: 'pro-breaking-link', href: article.url, target: '_blank', rel: 'noopener noreferrer' }, article.headline),
    h('time', {}, article.published ? timeAgo(article.published) : ''));
}

function scoreboardTile(team) {
  const game = team.live || team.next || team.last;
  const state = team.live ? 'live' : team.next ? 'upcoming' : team.last ? 'final' : 'none';
  const lines = [];
  if (!game) {
    lines.push(h('p', { class: 'pro-tile-main' }, 'No game scheduled'));
  } else {
    const oppLine = `${game.isHome ? 'vs' : 'at'} ${game.opponent.name}`;
    lines.push(h('p', { class: 'pro-tile-opp' }, oppLine));
    if (state === 'live' || state === 'final') {
      lines.push(h('p', { class: 'pro-tile-score mono' }, scoreLine(game) || '—'));
      lines.push(h('p', { class: 'pro-tile-sub' }, state === 'live' ? `${game.statusText} · LIVE` : game.statusText || 'Final'));
    } else {
      lines.push(h('p', { class: 'pro-tile-sub' }, etDayTime(game.date)));
    }
  }
  return h('a', { class: `pro-tile state-${state}`, href: `#/pro-sports/${team.key}`, style: `--c:${team.color}` },
    h('div', { class: 'pro-tile-head' }, teamLogo(team, 32), h('div', {},
      h('p', { class: 'pro-tile-name' }, team.short),
      h('p', { class: 'pro-tile-record mono' }, team.record || '—'))),
    h('div', { class: 'pro-tile-body' }, lines),
    h('span', { class: `pro-status-chip state-${state}` }, state === 'none' ? 'NO GAME' : gameStatusLabel(game)));
}

function standingsRow(entry, columns, highlightAbbrs) {
  const cells = [h('td', { class: 'pro-team-cell' }, teamLogo({ logo: entry.logo, short: entry.abbr, color: '#888' }, 20), entry.name)];
  for (const [key] of columns) cells.push(h('td', { class: 'num mono' }, entry.stats[key] ?? '\u2014'));
  return h('tr', { class: highlightAbbrs.includes(entry.abbr) ? 'pro-row-highlight' : '' }, cells);
}

function standingsGroup(conf, columns, highlightAbbrs) {
  const headRow = h('tr', {}, h('th', {}, 'Team'), columns.map(([, label]) => h('th', { class: 'num' }, label)));
  const bodyRows = conf.entries.map((entry) => standingsRow(entry, columns, highlightAbbrs));
  const table = h('table', { class: 'pro-table' }, h('thead', {}, headRow), h('tbody', {}, bodyRows));
  return h('div', { class: 'pro-standings-group' }, h('h3', { class: 'pro-standings-title' }, conf.name), h('div', { class: 'pro-table-wrap' }, table));
}

function standingsTable(conferences, columns, highlightAbbrs) {
  if (!conferences) return h('div', { class: 'pro-empty' }, h('p', {}, 'Standings are unavailable right now. Try again shortly.'));
  return h('div', { class: 'pro-standings' }, conferences.map((conf) => standingsGroup(conf, columns, highlightAbbrs)));
}

function gameRow(game, team) {
  const status = gameStatusLabel(game);
  return h('a', { class: `pro-gamerow state-${game.status}`, href: `#/pro-sports/${team.key}/game/${game.id}` },
    h('span', { class: 'pro-gamerow-date mono' }, etDay(game.date)),
    h('span', { class: 'pro-gamerow-opp' }, `${game.isHome ? 'vs' : 'at'} ${game.opponent.name}`),
    h('span', { class: 'pro-gamerow-info muted' }, game.status === 'upcoming' ? etTime(game.date) : (scoreLine(game) ? `${team.short.slice(0, 1)} ${scoreLine(game)}` : game.statusText)),
    h('span', { class: `pro-status-chip small state-${game.status}` }, status));
}

// ---------- filters ----------

function filterBar(options, current, onPick, label) {
  return h('div', { class: 'pro-filters', role: 'group', 'aria-label': label },
    options.map(([value, text]) => h('button', {
      type: 'button', class: 'pro-filter', 'aria-pressed': String(current === value),
      onclick: () => onPick(value),
    }, text)));
}

// ---------- team dashboard (shared by landing spotlight and team hub) ----------

function dashboardStats(team) {
  const rows = [
    ['Record', team.record || 'Unavailable'],
    ['Standing', team.standingSummary || 'Unavailable'],
  ];
  if (team.next) rows.push(['Next game', `${team.next.isHome ? 'vs' : 'at'} ${team.next.opponent.name} — ${etDayTime(team.next.date)}`]);
  if (team.last) rows.push(['Latest result', `${team.last.isHome ? 'vs' : 'at'} ${team.last.opponent.name}: ${scoreLine(team.last) || team.last.statusText} (${team.last.statusText})`]);
  return h('dl', { class: 'pro-dash' }, rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
}

// ============================================================
// Landing page: #/pro-sports
// ============================================================

export async function proLandingPage() {
  const data = await loadPro();
  const allNews = TEAM_ORDER.flatMap((key) => data.teams[key].news.map((a) => ({ ...a, teamKey: key })));
  const bySpecificity = [...allNews].filter((a) => a.specific).sort((a, b) => new Date(b.published) - new Date(a.published));
  const lead = bySpecificity[0] || allNews[0];
  const supporting = (lead ? allNews.filter((a) => a.id !== lead.id) : allNews).slice(0, 4);

  setTitle([]);
  const heroTeam = lead ? data.teams[lead.teamKey] : data.teams.panthers;
  const breaking = allNews.find((a) => a.breaking);
  const hero = lead ? h('section', { class: 'pro-hero' },
    h('div', { class: 'pro-hero-media' },
      lead.image ? (() => { const img = h('img', { src: lead.image, alt: lead.imageCaption || lead.headline, class: 'pro-hero-img' }); img.addEventListener('error', () => img.replaceWith(teamMonogram(heroTeam, 'pro-mono-hero')), { once: true }); return img; })() : teamMonogram(heroTeam, 'pro-mono-hero'),
      h('div', { class: 'pro-hero-scrim' })),
    h('div', { class: 'pro-hero-copy' },
      h('div', { class: 'pro-card-meta' }, teamPill(heroTeam), categoryPill(lead.category), h('span', { class: 'pro-dot' }, '·'), h('time', {}, lead.published ? timeAgo(lead.published) : '')),
      h('h1', { class: 'pro-hero-head' }, lead.headline),
      lead.description ? h('p', { class: 'pro-hero-dek' }, lead.description) : null,
      h('a', { class: 'pro-hero-cta', href: lead.url, target: '_blank', rel: 'noopener noreferrer' }, 'Read the full story on ESPN ↗'))) : null;

  const breakingNode = breaking ? breakingBanner(breaking, data.teams[breaking.teamKey]) : null;
  const header = h('div', { class: 'pro-section-head' },
    breakingNode,
    h('p', { class: 'pro-eyebrow' }, 'NC Sports Report'),
    h('h1', { class: 'pro-title' }, 'Pro Sports'),
    h('p', { class: 'pro-dek' }, 'Carolina Panthers, Charlotte Hornets and Carolina Hurricanes — scores, standings and the latest reporting in one place.'));

  const scoreboard = h('section', { class: 'pro-section' },
    h('h2', { class: 'pro-section-title' }, 'Scoreboard'),
    h('div', { class: 'pro-tiles' }, TEAM_ORDER.map((key) => scoreboardTile(data.teams[key]))));

  const feedHost = h('div', {});
  const feedState = { team: 'all', category: 'all' };
  const drawFeed = () => {
    let items = allNews;
    if (feedState.team !== 'all') items = items.filter((a) => a.teamKey === feedState.team);
    if (feedState.category !== 'all') items = items.filter((a) => a.category === feedState.category);
    items = items.sort((a, b) => new Date(b.published) - new Date(a.published));
    const cats = ['all', ...CATEGORY_ORDER.filter((c) => allNews.some((a) => a.category === c))];
    feedHost.replaceChildren(
      filterBar([['all', 'All Pro Sports'], ...TEAM_ORDER.map((k) => [k, data.teams[k].short])], feedState.team, (v) => { feedState.team = v; drawFeed(); }, 'Filter by team'),
      filterBar(cats.map((c) => [c, c === 'all' ? 'All categories' : c]), feedState.category, (v) => { feedState.category = v; drawFeed(); }, 'Filter by category'),
      items.length
        ? loadMoreGrid(items, (a) => articleCard(a, data.teams[a.teamKey], 'standard'))
        : h('div', { class: 'pro-empty' }, h('p', {}, 'No stories match this filter right now.')));
  };
  drawFeed();

  const spotlight = h('section', { class: 'pro-section' },
    h('h2', { class: 'pro-section-title' }, 'Team Spotlight'),
    h('div', { class: 'pro-spotlight-grid' }, TEAM_ORDER.map((key) => teamSpotlightPanel(data.teams[key]))));

  const standings = h('section', { class: 'pro-section' },
    h('h2', { class: 'pro-section-title' }, 'Standings'),
    h('div', { class: 'pro-standing-snap' }, TEAM_ORDER.map((key) => {
      const t = data.teams[key];
      return h('a', { class: 'pro-snap', href: `#/pro-sports/scores?league=${t.league}`, style: `--c:${t.color}` },
        teamLogo(t, 26), h('div', {}, h('p', { class: 'pro-snap-team' }, t.short), h('p', { class: 'pro-snap-line muted' }, t.standingSummary || 'Standing unavailable')));
    })),
    h('a', { class: 'pro-link-more', href: '#/pro-sports/scores' }, 'View full standings and schedules →'));

  const page = h('div', { class: 'pro page-enter', 'data-pro-live': 'landing' },
    h('div', { class: 'container pro-page' }, header, hero, scoreboard, h('section', { class: 'pro-section' },
      h('div', { class: 'pro-section-head-row' }, h('h2', { class: 'pro-section-title' }, 'Latest Pro Sports News'), h('a', { class: 'pro-link-more', href: '#/pro-sports/scores' }, 'Scores & Schedules →')),
      feedHost), spotlight, standings));
  registerLive(page, async () => { await loadPro(true); location.hash === '#/pro-sports' && render(); });
  return page;
}

function teamSpotlightPanel(team) {
  const latest = team.news[0];
  return h('a', { class: 'pro-spot', href: `#/pro-sports/${team.key}`, style: `--c:${team.color}; --c2:${team.colorDark || team.color}` },
    h('div', { class: 'pro-spot-top' }, teamLogo(team, 40), h('span', { class: 'pro-spot-league' }, team.leagueLabel)),
    h('h3', { class: 'pro-spot-name' }, team.name),
    h('p', { class: 'pro-spot-desc muted' }, spotlightCopy(team)),
    h('p', { class: 'pro-spot-record mono' }, team.record || '—', ' · ', team.standingSummary || 'Standing unavailable'),
    latest ? h('p', { class: 'pro-spot-latest' }, latest.headline) : null,
    h('span', { class: 'pro-spot-cta' }, `${team.short} coverage →`));
}

function spotlightCopy(team) {
  const copy = {
    panthers: 'NFL coverage: game previews, recaps, roster news and transactions.',
    hornets: 'NBA coverage: game previews, recaps, player development and roster moves.',
    hurricanes: 'NHL coverage: game previews, recaps, injuries and playoff storylines.',
  };
  return copy[team.key] || '';
}

// A simple "load more" control: shows a batch, grows on click. No fake infinite data.
function loadMoreGrid(items, renderItem, batch = 9) {
  const host = h('div', { class: 'pro-grid' });
  const more = h('button', { type: 'button', class: 'btn ghost pro-loadmore' }, 'Load more');
  let shown = 0;
  const draw = () => {
    shown = Math.min(items.length, shown + batch);
    host.replaceChildren(...items.slice(0, shown).map(renderItem));
    more.style.display = shown >= items.length ? 'none' : '';
  };
  more.addEventListener('click', draw);
  draw();
  return h('div', {}, host, items.length > batch ? more : null);
}

// ============================================================
// Team hub: #/pro-sports/:team
// ============================================================

const CATEGORY_SECTIONS = {
  panthers: ['Latest Panthers News', 'Game Previews', 'Game Recaps', 'Film Room & Analysis', 'Player Performance', 'Injury Reports', 'Roster & Transactions', 'NFL Draft', 'Opinion & Features'],
  hornets: ['Latest Hornets News', 'Game Previews', 'Game Recaps', 'Player Performance', 'Injury Reports', 'Trades & Transactions', 'NBA Draft', 'Analysis & Opinion'],
  hurricanes: ['Latest Hurricanes News', 'Game Previews', 'Game Recaps', 'Player Performance', 'Goaltending', 'Injury Reports', 'Roster Moves', 'Playoff Coverage'],
};

export async function proTeamPage(teamKey) {
  const data = await loadPro();
  const team = data.teams[teamKey];
  if (!team) throw Object.assign(new Error('That team is not covered here.'), { status: 404 });

  setTitle([team.name]);
  const breaking = team.news.find((a) => a.breaking);
  const upcoming = team.games.filter((g) => g.status === 'upcoming').sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 6);
  const recent = team.games.filter((g) => g.status === 'final').sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);

  const hero = h('header', { class: 'pro-team-hero', style: `--c:${team.color}; --c2:${team.colorDark || team.color}` },
    h('div', { class: 'container pro-team-hero-inner' },
      h('div', { class: 'pro-breadcrumbs' }, h('a', { href: '#/pro-sports' }, 'Pro Sports'), ' / ', h('span', {}, team.short)),
      h('div', { class: 'pro-team-hero-row' },
        teamLogo(team, 72),
        h('div', {},
          h('p', { class: 'pro-eyebrow' }, team.leagueLabel),
          h('h1', { class: 'pro-team-title' }, team.name))),
      dashboardStats(team)));

  const feedHost = h('div', {});
  const state = { category: 'all' };
  const cats = ['all', ...CATEGORY_ORDER.filter((c) => team.news.some((a) => a.category === c))];
  const drawFeed = () => {
    const items = state.category === 'all' ? team.news : team.news.filter((a) => a.category === state.category);
    feedHost.replaceChildren(
      filterBar(cats.map((c) => [c, c === 'all' ? `Latest ${team.short} News` : c]), state.category, (v) => { state.category = v; drawFeed(); }, 'Filter news'),
      items.length ? loadMoreGrid(items, (a) => articleCard(a, team, 'standard')) : h('div', { class: 'pro-empty' }, h('p', {}, `No ${state.category === 'all' ? '' : state.category.toLowerCase() + ' '}stories right now. Check back soon.`)));
  };
  drawFeed();

  const schedule = h('section', { class: 'pro-section' },
    h('div', { class: 'pro-two-col' },
      h('div', {},
        h('h2', { class: 'pro-section-title' }, 'Upcoming Games'),
        upcoming.length ? h('div', { class: 'pro-gamerows' }, upcoming.map((g) => gameRow(g, team))) : h('p', { class: 'pro-empty-inline muted' }, 'No games currently scheduled.')),
      h('div', {},
        h('h2', { class: 'pro-section-title' }, 'Recent Results'),
        recent.length ? h('div', { class: 'pro-gamerows' }, recent.map((g) => gameRow(g, team))) : h('p', { class: 'pro-empty-inline muted' }, 'No completed games yet this season.'))));

  const browse = h('section', { class: 'pro-section' },
    h('h2', { class: 'pro-section-title' }, 'Browse Coverage'),
    h('div', { class: 'pro-chip-grid' }, (CATEGORY_SECTIONS[teamKey] || []).map((label) => h('span', { class: 'pro-chip' }, label))),
    h('p', { class: 'pro-empty-inline muted', style: 'margin-top:10px' }, 'Sections with no current stories will fill in automatically as ESPN publishes them — nothing here is invented.'));

  const standingsSection = h('section', { class: 'pro-section' },
    h('div', { class: 'pro-section-head-row' }, h('h2', { class: 'pro-section-title' }, `${team.leagueLabel} Standings`), h('a', { class: 'pro-link-more', href: `#/pro-sports/scores?league=${team.league}` }, 'Full standings →')),
    standingsTable(data.standings[team.league]?.conferences, STANDINGS_COLUMNS_CLIENT[team.league], [team.key === 'panthers' ? 'CAR' : team.key === 'hurricanes' ? 'CAR' : 'CHA']));

  const page = h('div', { class: 'pro page-enter', 'data-pro-live': teamKey },
    breaking ? h('div', { class: 'container', style: 'padding-top:16px' }, breakingBanner(breaking, team)) : null,
    hero,
    h('div', { class: 'container pro-page' },
      h('section', { class: 'pro-section' }, h('h2', { class: 'pro-section-title' }, 'Coverage'), feedHost),
      schedule, browse, standingsSection));
  registerLive(page, async () => { await loadPro(true); location.hash === `#/pro-sports/${teamKey}` && render(); });
  return page;
}

const STANDINGS_COLUMNS_CLIENT = {
  nfl: [['overall', 'W-L-T'], ['winPercent', 'PCT'], ['gamesBehind', 'GB'], ['streak', 'STRK']],
  nba: [['overall', 'W-L'], ['winPercent', 'PCT'], ['gamesBehind', 'GB'], ['streak', 'STRK']],
  nhl: [['overall', 'W-L-OTL'], ['points', 'PTS'], ['gamesBehind', 'GB'], ['streak', 'STRK']],
};

// ============================================================
// Scores & Schedules: #/pro-sports/scores
// ============================================================

export async function proScoresPage(params) {
  const data = await loadPro();
  const allGames = TEAM_ORDER.flatMap((key) => data.teams[key].games.map((g) => ({ ...g, teamKey: key })));
  const state = { team: 'all', league: params.get('league') || 'all' };

  setTitle(['Scores & Schedules']);
  const header = h('div', { class: 'pro-section-head' },
    h('div', { class: 'pro-breadcrumbs' }, h('a', { href: '#/pro-sports' }, 'Pro Sports'), ' / ', h('span', {}, 'Scores & Schedules')),
    h('h1', { class: 'pro-title' }, 'Scores & Schedules'),
    h('p', { class: 'pro-dek' }, 'Every Panthers, Hornets and Hurricanes game this season, plus full NFL, NBA and NHL standings.'));

  const gamesHost = h('div', {});
  const drawGames = () => {
    let items = allGames;
    if (state.team !== 'all') items = items.filter((g) => g.teamKey === state.team);
    const upcoming = items.filter((g) => g.status === 'upcoming' || g.status === 'live').sort((a, b) => new Date(a.date) - new Date(b.date));
    const completed = items.filter((g) => g.status === 'final' || g.status === 'postponed').sort((a, b) => new Date(b.date) - new Date(a.date));
    gamesHost.replaceChildren(
      filterBar([['all', 'All Teams'], ...TEAM_ORDER.map((k) => [k, data.teams[k].short])], state.team, (v) => { state.team = v; drawGames(); }, 'Filter by team'),
      h('div', { class: 'pro-two-col' },
        h('div', {}, h('h2', { class: 'pro-section-title' }, 'Upcoming'), upcoming.length ? h('div', { class: 'pro-gamerows' }, upcoming.map((g) => gameRow(g, data.teams[g.teamKey]))) : h('p', { class: 'pro-empty-inline muted' }, 'Nothing scheduled.')),
        h('div', {}, h('h2', { class: 'pro-section-title' }, 'Completed'), completed.length ? h('div', { class: 'pro-gamerows' }, completed.map((g) => gameRow(g, data.teams[g.teamKey]))) : h('p', { class: 'pro-empty-inline muted' }, 'No completed games yet.'))));
  };
  drawGames();

  const standingsHost = h('div', {});
  const drawStandings = () => {
    const league = state.league === 'all' ? 'nfl' : state.league;
    const t = TEAM_ORDER.map((k) => data.teams[k]).find((t) => t.league === league);
    standingsHost.replaceChildren(
      filterBar(['nfl', 'nba', 'nhl'].map((l) => [l, LEAGUE_LABEL[l]]), league, (v) => { state.league = v; drawStandings(); }, 'Choose league'),
      data.standings[league]
        ? h('div', {}, h('p', { class: 'muted small mono', style: 'margin:4px 0 14px' }, data.standings[league].season ? `${data.standings[league].season} season` : ''), standingsTable(data.standings[league].conferences, STANDINGS_COLUMNS_CLIENT[league], [t ? t.key === 'hornets' ? 'CHA' : 'CAR' : '']))
        : h('div', { class: 'pro-empty' }, h('p', {}, `${LEAGUE_LABEL[league]} standings are unavailable right now.`)));
  };
  drawStandings();

  const page = h('div', { class: 'pro page-enter', 'data-pro-live': 'scores' },
    h('div', { class: 'container pro-page' }, header,
      h('section', { class: 'pro-section' }, gamesHost),
      h('section', { class: 'pro-section' }, h('h2', { class: 'pro-section-title' }, 'League Standings'), standingsHost)));
  registerLive(page, async () => { await loadPro(true); location.hash.startsWith('#/pro-sports/scores') && render(); });
  return page;
}

// ============================================================
// Game page (preview / live / recap): #/pro-sports/:team/game/:id
// ============================================================

export async function proGamePage(teamKey, gameId) {
  const data = await loadPro();
  const team = data.teams[teamKey];
  if (!team) throw Object.assign(new Error('That team is not covered here.'), { status: 404 });
  const game = team.games.find((g) => g.id === gameId);
  if (!game) throw Object.assign(new Error('That game could not be found.'), { status: 404 });

  const kind = game.status === 'final' ? 'Game Recap' : game.status === 'live' ? 'Live' : 'Game Preview';
  setTitle([`${team.short} ${game.isHome ? 'vs' : 'at'} ${game.opponent.name}`, kind]);
  const matchup = h('div', { class: 'pro-matchup' },
    h('div', { class: 'pro-matchup-side' }, teamLogo(team, 56), h('p', {}, team.short), h('p', { class: 'muted small' }, team.usRecordLabel || game.usRecord || '')),
    h('div', { class: 'pro-matchup-mid' },
      scoreLine(game) ? h('p', { class: 'pro-matchup-score mono' }, `${game.isHome ? game.score.us : game.score.them} – ${game.isHome ? game.score.them : game.score.us}`) : h('p', { class: 'pro-matchup-at' }, game.isHome ? 'VS' : 'AT'),
      h('span', { class: `pro-status-chip state-${game.status}` }, gameStatusLabel(game))),
    h('div', { class: 'pro-matchup-side' }, teamLogo({ logo: game.opponent.logo, short: game.opponent.abbr, color: '#888' }, 56), h('p', {}, game.opponent.name), h('p', { class: 'muted small' }, game.opponent.record || '')));

  const details = h('dl', { class: 'pro-dash' },
    h('div', {}, h('dt', {}, 'Matchup'), h('dd', {}, `${team.name} ${game.isHome ? 'vs' : 'at'} ${game.opponent.name}`)),
    h('div', {}, h('dt', {}, 'Venue'), h('dd', {}, game.venue ? [game.venue.name, [game.venue.city, game.venue.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : 'TBD')),
    h('div', {}, h('dt', {}, team.kickoffNoun || 'Start time'), h('dd', {}, etDayTime(game.date))),
    h('div', {}, h('dt', {}, 'Home / Away'), h('dd', {}, game.isHome ? 'Home' : 'Away')),
    h('div', {}, h('dt', {}, 'Status'), h('dd', {}, game.statusText || gameStatusLabel(game))));

  const recapBlock = game.recap?.text
    ? h('div', { class: 'pro-recap' }, h('p', {}, game.recap.text), h('p', { class: 'pro-card-source' }, 'Reporting by ESPN ↗'))
    : null;

  const leaders = game.leaders.length
    ? h('div', { class: 'pro-leaders' }, game.leaders.map((l) => h('div', { class: 'pro-leader' }, h('p', { class: 'muted small' }, l.category), h('p', {}, l.athlete), h('p', { class: 'mono small' }, l.line))))
    : null;

  const links = Object.entries(game.links || {}).filter(([, url]) => url);
  const linkRow = links.length ? h('div', { class: 'cta-row' }, links.map(([name, url]) => h('a', { class: 'btn ghost small-btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, `${name[0].toUpperCase()}${name.slice(1)} on ESPN ↗`))) : null;

  const related = team.news.filter((a) => a.category === (game.status === 'final' ? 'Game Recap' : 'Game Preview') || a.specific).slice(0, 3);

  const page = h('div', { class: 'pro page-enter' },
    h('div', { class: 'container pro-page pro-page--narrow' },
      h('div', { class: 'pro-breadcrumbs' }, h('a', { href: '#/pro-sports' }, 'Pro Sports'), ' / ', h('a', { href: `#/pro-sports/${teamKey}` }, team.short), ' / ', h('span', {}, kind)),
      h('p', { class: 'pro-eyebrow' }, kind),
      h('h1', { class: 'pro-title' }, `${team.short} ${game.isHome ? 'vs' : 'at'} ${game.opponent.name}`),
      matchup, details, recapBlock, leaders, linkRow,
      related.length ? h('section', { class: 'pro-section' }, h('h2', { class: 'pro-section-title' }, `More ${team.short} Coverage`), h('div', { class: 'pro-grid' }, related.map((a) => articleCard(a, team, 'compact')))) : null,
      h('a', { class: 'btn ghost', href: `#/pro-sports/${teamKey}`, style: 'margin-top:28px' }, `← Back to ${team.short} Hub`)));
  return page;
}

// ---------- live refresh plumbing (polling, mirrors live-map.js) ----------

function registerLive(hostNode, refresh) {
  pro.instances.add({ host: hostNode, refresh });
  if (!pro.timer) {
    pro.timer = setInterval(() => {
      for (const inst of [...pro.instances]) {
        if (!inst.host.isConnected) { pro.instances.delete(inst); continue; }
        if (document.visibilityState === 'visible') inst.refresh().catch(() => {});
      }
    }, 30000);
  }
}

// A tiny indirection so this module doesn't need to import app.js's render() directly.
let render = () => {};
export function setProRenderer(fn) { render = fn; }
