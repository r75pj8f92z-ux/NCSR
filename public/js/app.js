import { nc7Page, nc7MiniMap, initNc7, startLive } from './live-map.js';
import { proLandingPage, proTeamPage, proScoresPage, proGamePage, setProRenderer } from './pro-sports.js';

// North Carolina Sports Report front end. Hash routing, no framework. All user-supplied text goes through
// textContent (via el()), never innerHTML.

const RANK = { free: 0, insider: 1, elite: 2 };
const TIER_LABEL = { free: 'Free', insider: 'Insider', elite: 'Elite' };
const PRICE = { insider: 5, elite: 20 };

const state = {
  config: null,
  user: null,
  live: new Set(),
  renderId: 0,
};

const app = document.getElementById('app');
const header = document.getElementById('siteHeader');

// ---------- helpers ----------

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
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

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

const sportLabel = (id) => state.config.sports.find((s) => s.id === id)?.label ?? id;
const programFor = (id) => state.config.programs.find((p) => p.id === id);
const hasTier = (tier) => RANK[state.user?.tier || 'free'] >= RANK[tier];
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

function formatDate(value) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(`${value}T12:00:00`);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(ms) {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3200);
}

function setButtonBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = busy ? 'Working...' : label;
}

function tierPill(tier) {
  return el('span', { class: `pill ${tier}` }, TIER_LABEL[tier]);
}

function stagger(nodes, step = 70) {
  nodes.forEach((node, i) => node.style.setProperty('--d', `${i * step}ms`));
  return nodes;
}

function section(title, ...children) {
  return el('section', { class: 'section' }, el('div', { class: 'row-between' }, el('h2', { class: 'section-title reveal' }, title)), ...children);
}

function errorView(err) {
  const message = err.status === 404 ? 'We could not find that page.' : err.message;
  return el('section', { class: 'page container' },
    el('div', { class: 'notice' },
      el('h3', {}, 'Something needs attention'),
      el('p', { class: 'muted' }, message),
      el('div', {}, el('a', { class: 'btn ghost', href: '#/' }, 'Back to home'))));
}

function lockedPanel(tier, programName) {
  const price = PRICE[tier];
  const headline = tier === 'insider' ? 'Insider access' : 'Elite access';
  const copy = tier === 'insider'
    ? `Breaking news, insider intel, and NIL estimates${programName ? ` for ${programName}` : ''}.`
    : `Full rosters, AI team analysis, NC Metrics, and team history${programName ? ` for ${programName}` : ''}.`;
  return el('div', { class: 'locked-panel reveal' },
    tierPill(tier),
    el('h3', {}, headline),
    el('p', { class: 'muted' }, `${copy} Included with the ${TIER_LABEL[tier]} plan at $${price} per month.`),
    el('a', { class: 'btn primary', href: '#/pricing' }, `Unlock ${TIER_LABEL[tier]}`));
}

// ---------- layout chrome ----------

function renderNav() {
  const nav = document.getElementById('siteNav');
  const current = (location.hash.replace(/^#/, '').split('?')[0]) || '/';
  const link = (path, label) => {
    const active = current === path || (path !== '/' && current.startsWith(path));
    return el('a', { href: `#${path}`, class: active ? 'active' : '' }, label);
  };
  nav.replaceChildren(
    link('/', 'Home'),
    link('/sport/football', 'Football'),
    link('/sport/mens-basketball', "Men’s Basketball"),
    link('/teams', 'Teams'),
    link('/discuss', 'Discussion'),
    link('/nc7-live-map', 'Live Map'),
    link('/pro-sports', 'Pro Sports'),
    link('/nextgen', 'NC Metrics'),
    link('/pricing', 'Plans'),
    state.user
      ? link('/account', state.user.displayName)
      : link('/login', 'Log in'),
  );
  header.classList.remove('open');
  document.getElementById('navToggle').setAttribute('aria-expanded', 'false');
}

function renderFooter() {
  const social = Object.entries(state.config.social).filter(([, url]) => url);
  const label = (key) => key.charAt(0).toUpperCase() + key.slice(1);
  document.getElementById('siteFooter').replaceChildren(
    el('div', { class: 'container footer-grid' },
      el('div', {},
        el('div', { class: 'brand-mark' },
          el('span', { class: 'logo-mark logo-sm', role: 'img', 'aria-label': 'North Carolina Sports Report logo' }),
          el('span', { class: 'brand-name' }, 'NC Sports ', el('em', {}, 'Report'))),
        el('p', { class: 'muted' }, state.config.brand.tagline)),
      el('div', {},
        el('h4', {}, 'Follow'),
        social.length
          ? el('ul', { class: 'social' }, social.map(([key, url]) =>
              el('li', {}, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label(key)))))
          : el('p', { class: 'muted small' }, 'Social links are set in data/content.json.')),
      el('div', {},
        el('h4', {}, 'Disclaimer'),
        el('p', { class: 'muted small' },
          'Independent fan coverage. North Carolina Sports Report is not affiliated with, endorsed by, or sponsored by any university or athletic conference. Team names and marks belong to their respective owners.'))),
    el('p', { class: 'container muted small copyright' }, `© ${new Date().getFullYear()} North Carolina Sports Report`),
  );
}

// ---------- components ----------

function newsCard(item) {
  const meta = el('div', { class: 'meta' },
    tierPill(item.tier),
    el('span', {}, programFor(item.program)?.short || ''),
    el('span', {}, '·'),
    el('span', {}, sportLabel(item.sport)),
    el('span', {}, '·'),
    el('span', {}, formatDate(item.publishedAt)));

  if (item.locked) {
    return el('article', { class: 'news-card locked reveal' },
      meta,
      el('h3', {}, item.title),
      el('p', { class: 'summary-blur muted' }, item.summary),
      el('div', { class: 'unlock-line' },
        el('span', {}, `Full story for ${TIER_LABEL[item.tier]} members.`),
        el('a', { href: '#/pricing' }, `Unlock with ${TIER_LABEL[item.tier]}`)));
  }
  return el('article', { class: 'news-card reveal' },
    meta,
    el('h3', {}, item.title),
    el('p', { class: 'muted' }, item.summary),
    el('p', { class: 'body' }, item.body),
    sourceLine(item));
}

function sourceLine(item) {
  if (!item.sourceUrl) return null;
  return el('p', { class: 'source-line small muted' }, 'Source: ',
    el('a', { href: item.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, item.sourceName || item.sourceUrl));
}

function newsList(items, empty = 'No stories yet. Check back soon.') {
  if (items.length === 0) return el('div', { class: 'notice' }, el('p', { class: 'muted' }, empty));
  return el('div', { class: 'news-list' }, stagger(items.map(newsCard)));
}

function teamCard(program) {
  return el('a', {
    class: 'team-card reveal',
    href: `#/team/${program.id}`,
    style: `--c: ${program.color}`,
  },
    el('span', { class: 'short' }, program.short),
    el('span', { class: 'nick' }, program.nickname),
    el('span', { class: 'muted small' }, program.name),
    el('span', { class: 'cta' }, 'Open coverage →'));
}

// ---------- pages ----------

async function homePage() {
  const [news, radar] = await Promise.all([api('/api/news'), api('/api/radar').catch(() => null)]);
  const headline = ['Carolina', 'sports,', 'covered', 'from', 'the', 'inside.'];
  const words = headline.flatMap((w, i) => [
    el('span', { class: 'word' }, el('span', { style: `--i:${i}` }, w === 'inside.' ? el('span', { class: 'accent' }, w) : w)),
    ' ',
  ]);

  const hero = el('section', { class: 'hero' },
    el('div', { class: 'container hero-grid' },
      el('div', { class: 'hero-inner' },
        el('p', { class: 'eyebrow hero-fade' }, 'North Carolina · Football & Men’s Basketball'),
        el('h1', { class: 'hero-title', 'aria-label': 'Carolina sports, covered from the inside.' }, words),
        el('p', { class: 'lede hero-fade' }, 'Insider news, a live fan discussion, and deep team data for seven North Carolina programs.'),
        el('div', { class: 'cta-row hero-fade' },
          el('a', { class: 'btn primary', href: '#/teams' }, 'Explore the teams'),
          el('a', { class: 'btn ghost', href: '#/pricing' }, 'See plans'))),
      el('div', { class: 'hero-logo hero-fade', 'aria-hidden': 'true' },
        el('span', { class: 'halo' }),
        el('span', { class: 'ring' }),
        el('span', { class: 'ring ring-2' }),
        el('span', { class: 'logo-mark' }))));

  const tickerItems = news.slice(0, 12);
  const ticker = tickerItems.length
    ? el('div', { class: 'ticker', 'aria-hidden': 'true' },
        el('div', { class: 'ticker-track' }, [...tickerItems, ...tickerItems].map((n) => el('span', {}, n.title))))
    : null;

  const sports = el('div', { class: 'grid cols-2' },
    ['football', 'mens-basketball'].map((id, i) => el('a', {
      class: 'sport-tile reveal',
      href: `#/sport/${id}`,
      style: `--d:${i * 90}ms`,
    },
      el('span', { class: 'big-num', 'aria-hidden': 'true' }, i === 0 ? 'FB' : 'MB'),
      el('span', { class: 'eyebrow' }, 'Sport'),
      el('h3', {}, sportLabel(id)),
      el('span', { class: 'muted' }, id === 'football' ? 'Depth charts, transfers, and the weekly grind.' : 'Recruiting, the portal, and every rotation change.'))));

  return el('div', { class: 'page-enter' },
    hero,
    ticker,
    el('div', { class: 'container' },
      radarPanel(radar),
      nc7MiniMap(),
      section('Seven programs', el('div', { class: 'grid cols-3' }, stagger(state.config.programs.map(teamCard)))),
      section('Sports', sports),
      section('Latest',
        el('p', { class: 'muted reveal' }, 'Free members see the basic story. Insider and Elite members get the full report.'),
        el('div', { style: 'height:12px' }),
        newsList(news.slice(0, 6), 'Stories are on the way.'),
        el('div', { style: 'margin-top:22px' }, el('a', { class: 'btn ghost', href: '#/sport/football' }, 'More football'))),
      section('Plans',
        el('div', { class: 'notice reveal' },
          el('h3', {}, 'Start free. Upgrade when you want the depth.'),
          el('p', { class: 'muted' }, `Insider is $${PRICE.insider} a month. Elite is $${PRICE.elite} a month. Cancel any time.`),
          el('div', {}, el('a', { class: 'btn primary', href: '#/pricing' }, 'Compare plans'))))));
}

// ---------- NC Sports Radar ----------

const radarState = { timer: null };

function radarTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

function radarGameLine(game) {
  return el('li', { class: 'radar-item' },
    el('span', { class: 'radar-main' }, game.name),
    el('span', { class: `radar-state ${game.state}` }, game.state === 'in' ? 'Live' : game.state === 'post' ? 'Final' : radarStatusTime(game)));
}

function radarStatusTime(game) {
  return game.statusText || 'Upcoming';
}

function radarTeamLine(t) {
  return `${t.rank ? `#${t.rank} ` : ''}${t.name}${t.record ? ` (${t.record})` : ''}`;
}

function radarCard(label, body, extra = '') {
  return el('article', { class: `radar-card reveal ${extra}` },
    el('p', { class: 'eyebrow' }, label),
    body);
}

function radarPanelBody(radar) {
  if (!radar) {
    return el('div', { class: 'radar-grid' }, el('p', { class: 'muted' }, 'Radar is unavailable right now. Try again in a minute.'));
  }
  const ncGames = radar.tonight;
  const games = ncGames.length
    ? el('ul', { class: 'radar-list' }, ncGames.map(radarGameLine))
    : el('p', { class: 'muted small' }, 'No North Carolina games on the board right now.');

  const matchup = radar.biggestMatchup
    ? el('div', {},
        el('p', { class: 'radar-headline' }, radar.biggestMatchup.name),
        el('p', { class: 'muted small' }, radar.biggestMatchup.teams.map(radarTeamLine).join('  vs  ')),
        el('p', { class: 'muted small' }, radar.biggestMatchup.statusText))
    : el('p', { class: 'muted small' }, 'No matchup on the board right now.');

  const upsets = radar.upsets.length
    ? el('ul', { class: 'radar-list' }, radar.upsets.map((u) => el('li', { class: 'radar-item upset' },
        el('span', { class: 'radar-main' }, `${u.winnerRank ? `#${u.winnerRank} ` : ''}${u.winner} over ${u.loserRank ? `#${u.loserRank} ` : ''}${u.loser}`),
        el('span', { class: 'radar-state' }, u.score))))
    : el('p', { class: 'muted small' }, 'No upsets flagged today.');

  const score = radar.latestScore
    ? el('div', {},
        el('p', { class: 'radar-headline' }, radar.latestScore.teams.map((t) => `${t.abbr} ${t.score ?? ''}`).join('  ')),
        el('p', { class: 'muted small' }, `${radar.latestScore.name} · ${radar.latestScore.statusText}`))
    : el('p', { class: 'muted small' }, 'No North Carolina scores yet today.');

  const athlete = radar.trendingAthlete
    ? el('div', {},
        el('p', { class: 'radar-headline' }, radar.trendingAthlete.athlete),
        el('p', { class: 'muted small' }, `${radar.trendingAthlete.teamName || ''} · ${radar.trendingAthlete.category}: ${radar.trendingAthlete.line}`))
    : el('p', { class: 'muted small' }, 'No top performer posted yet.');

  const news = radar.breakingNews.length
    ? el('ul', { class: 'radar-list' }, radar.breakingNews.slice(0, 3).map((n) => el('li', { class: 'radar-item' },
        n.url
          ? el('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer', class: 'radar-main' }, n.headline)
          : el('span', { class: 'radar-main' }, n.headline),
        el('span', { class: 'radar-state' }, n.source))))
    : el('p', { class: 'muted small' }, 'No breaking news right now.');

  const commitment = radar.latestCommitment
    ? el('p', {}, radar.latestCommitment.text)
    : el('p', { class: 'muted small' }, 'Commitment tracking is not connected yet. Recruiting data needs a licensed feed.');

  return el('div', { class: 'radar-grid' },
    radarCard('Games tonight', games, 'radar-wide'),
    radarCard('Biggest matchup', matchup),
    radarCard('Upset alerts', upsets),
    radarCard('Latest commitment', commitment),
    radarCard('Latest score', score),
    radarCard('Trending athlete', athlete),
    radarCard('Breaking news', news, 'radar-wide'));
}

function radarPanel(radar) {
  const host = el('div', { class: 'radar-host' });
  const panel = (data) => el('section', { class: 'radar section', 'aria-label': 'NC Sports Radar' },
    el('div', { class: 'radar-head' },
      el('span', { class: 'radar-sweep', 'aria-hidden': 'true' }),
      el('div', {},
        el('h2', { class: 'section-title radar-title' }, 'NC Sports Radar'),
        el('p', { class: 'muted small mono' }, data ? `Live from ESPN · updated ${radarTime(data.asOf)} · ${data.date.slice(0, 4)}-${data.date.slice(4, 6)}-${data.date.slice(6)}` : 'Live data'))),
    radarPanelBody(data));
  host.append(panel(radar));
  clearInterval(radarState.timer);
  radarState.timer = setInterval(async () => {
    if (!host.isConnected) return clearInterval(radarState.timer);
    try {
      const fresh = await api('/api/radar');
      host.replaceChildren(panel(fresh));
      observeReveals(host);
    } catch {
      /* keep the last good snapshot */
    }
  }, 60000);
  return host;
}

function teamsPage() {
  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'page-head' },
      el('p', { class: 'eyebrow' }, 'Programs'),
      el('h1', { class: 'page-title' }, 'Seven teams. One network.'),
      el('p', { class: 'lede' }, 'Pick a program to see its news, insider intel, and premium team data.')),
    el('div', { class: 'grid cols-3' }, stagger(state.config.programs.map(teamCard))));
}

async function sportPage(sport) {
  if (!state.config.sports.some((s) => s.id === sport)) throw Object.assign(new Error('Unknown sport.'), { status: 404 });
  const news = await api(`/api/news?sport=${encodeURIComponent(sport)}`);
  const programRows = state.config.programs.map((program) => {
    const latest = news.find((n) => n.program === program.id);
    return el('a', {
      class: 'topic-row reveal',
      href: `#/team/${program.id}`,
      style: `--c:${program.color}; border-left: 3px solid ${program.color}`,
    },
      el('div', {},
        el('div', { class: 'title' }, `${program.short} ${program.nickname}`),
        el('div', { class: 'meta' }, latest ? latest.title : 'No stories yet')),
      el('span', { class: 'count' }, '→'));
  });

  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'page-head' },
      el('p', { class: 'eyebrow' }, 'Sport'),
      el('h1', { class: 'page-title' }, sportLabel(sport)),
      el('p', { class: 'lede' }, 'Every North Carolina program, coverage for the season.')),
    el('div', { class: 'grid cols-2' }, stagger(programRows, 50)),
    section('Latest stories', newsList(news.filter((n) => n.program), 'No stories for this sport yet.')));
}

async function teamPage(id, tab) {
  const [program, news] = await Promise.all([
    api(`/api/programs/${encodeURIComponent(id)}`),
    api(`/api/news?program=${encodeURIComponent(id)}`),
  ]);
  const color = program.color;
  const tabs = [['overview', 'Overview'], ['insider', 'Insider'], ['elite', 'Elite']];

  const head = el('header', { class: 'team-head', style: `--c:${color}` },
    el('div', { class: 'container' },
      el('p', { class: 'eyebrow', style: `color:${color}` }, program.name),
      el('h1', {}, program.short, ' ', el('span', { class: 'nick' }, program.nickname)),
      el('p', { class: 'lede', style: 'margin-top:14px' }, program.overview),
      el('nav', { class: 'tabs', 'aria-label': 'Team sections' },
        tabs.map(([key, label]) => el('a', {
          href: `#/team/${program.id}?tab=${key}`,
          'aria-current': tab === key ? 'page' : null,
        }, label, key !== 'overview' && !hasTier(key) ? el('span', { class: `pill ${key}` }, TIER_LABEL[key]) : null)))));

  let body;
  if (tab === 'insider') body = insiderTab(program, news);
  else if (tab === 'elite') body = eliteTab(program);
  else body = overviewTab(program, news);

  return el('div', { class: 'page-enter' }, head, el('section', { class: 'container page' }, body));
}

function overviewTab(program, news) {
  const sportCards = ['football', 'mens-basketball'].map((sport) => {
    const data = program.sports[sport] || {};
    const hasRecord = Boolean(data.record);
    return el('div', { class: 'stat reveal' },
      el('span', { class: 'label' }, sportLabel(sport)),
      el('span', { class: `value ${hasRecord ? '' : 'empty'}` }, hasRecord ? data.record : 'Preseason'),
      !hasRecord && data.note ? el('span', { class: 'muted small' }, data.note) : null,
      hasRecord && data.conference ? el('span', { class: 'muted small' }, data.conference) : null,
      el('span', { class: 'muted small' }, data.coach ? `Head coach: ${data.coach}` : 'Head coach: awaiting verified listing'),
      data.asOf ? el('span', { class: 'muted small mono' }, `As of ${formatDate(data.asOf)}`) : null,
      data.source ? el('span', { class: 'small' }, 'Source: ', el('a', { href: data.source, target: '_blank', rel: 'noopener noreferrer' }, 'view')) : null);
  });
  return el('div', {},
    el('div', { class: 'stat-grid' }, stagger(sportCards)),
    el('div', { class: 'row-between', style: 'margin-top:48px' },
      el('h2', { class: 'section-title reveal' }, 'Coverage')),
    newsList(news, `No stories for ${program.short} yet.`));
}

function insiderTab(program, news) {
  if (!program.insider) return lockedPanel('insider', program.short);
  const nilCards = ['football', 'mens-basketball'].map((sport) => {
    const nil = program.insider.nil[sport];
    return el('div', { class: 'stat reveal' },
      el('span', { class: 'label' }, `${sportLabel(sport)} NIL estimate`),
      el('span', { class: `value ${nil.estimate == null ? 'empty' : ''}` },
        nil.estimate == null ? 'No reliable estimate yet' : money(nil.estimate)),
      el('span', { class: 'muted small' }, nil.note || ''),
      nil.source ? el('span', { class: 'small' }, 'Source: ', el('a', { href: nil.source, target: '_blank', rel: 'noopener noreferrer' }, 'view')) : null);
  });
  const insiderNews = news.filter((n) => n.tier !== 'free');
  return el('div', {},
    el('h2', { class: 'section-title reveal' }, 'NIL snapshot'),
    el('div', { class: 'stat-grid' }, stagger(nilCards)),
    el('h2', { class: 'section-title reveal', style: 'margin-top:48px' }, 'Insider reports'),
    newsList(insiderNews, 'Insider reports will appear here as they are published.'));
}

const METRIC_COLUMNS = {
  football: ['ptsPerGame', 'ptsAllowedPerGame', 'passYpg', 'rushYpg', 'compPct', 'thirdDownPct', 'oppThirdDownPct', 'turnoverMargin', 'sacks', 'sacksAllowed'],
  'mens-basketball': ['ptsPerGame', 'fgPct', 'threePct', 'ftPct', 'apg', 'topg', 'astTo', 'rpg', 'spg', 'bpg'],
};

function formatMetric(def, value) {
  if (value === null || value === undefined) return '—';
  if (def && def.unit === 'pct') return `${value.toFixed(1)}%`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function metricCell(def, stat) {
  return el('td', { class: 'num' },
    formatMetric(def, stat ? stat.value : null),
    stat && stat.rank ? el('span', { class: 'rank' }, ` #${stat.rank}`) : null);
}

function sportToggle(options, current, onPick) {
  return el('div', { class: 'subtabs', role: 'group', 'aria-label': 'Choose sport' },
    options.map(([id, label]) => el('button', {
      type: 'button',
      'aria-pressed': id === current ? 'true' : 'false',
      onclick: () => onPick(id),
    }, label)));
}

function eliteTab(program) {
  if (!program.history) return lockedPanel('elite', program.short);

  const snapshotHost = el('div', {}, el('p', { class: 'muted' }, 'Loading NC Metrics...'));
  const rosterHost = el('div', {}, el('p', { class: 'muted' }, 'Loading roster...'));
  const analysisHost = el('div', {}, el('p', { class: 'muted' }, 'Loading analysis...'));

  const bindSport = (host, loader) => {
    const bar = sportToggle([['football', 'Football'], ['mens-basketball', "Men's Basketball"]], 'football', async (sport) => {
      bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sport === sport)));
      host.replaceChildren(el('p', { class: 'muted' }, 'Loading...'));
      host.replaceChildren(await loader(sport));
    });
    bar.querySelectorAll('button').forEach((b, i) => { b.dataset.sport = ['football', 'mens-basketball'][i]; });
    return bar;
  };

  const loadSnapshot = async (sport) => {
    try {
      const data = await api('/api/premium/metrics');
      const team = data.teams.find((t) => t.programId === program.id && t.sport === sport);
      if (!team) return el('p', { class: 'muted' }, 'No metrics for this sport yet.');
      const defs = Object.fromEntries(data.definitions[sport].map((d) => [d.key, d]));
      const keys = METRIC_COLUMNS[sport].slice(0, 6);
      return el('div', {},
        el('p', { class: 'muted small mono' }, `${team.season} · ${team.gamesCounted} games counted by ESPN` +
          (team.stale ? ` · record shows ${team.gamesOnRecord}, so recent results are not yet in the feed` : '')),
        el('div', { class: 'stat-grid' }, stagger(keys.map((k) => el('div', { class: 'stat reveal' },
          el('span', { class: 'label' }, defs[k].label),
          el('span', { class: 'value' }, formatMetric(defs[k], team.stats[k] ? team.stats[k].value : null)),
          el('span', { class: 'muted small' }, team.stats[k] && team.stats[k].rank ? `Rank ${team.stats[k].rank} of 7` : ''))))),
        el('p', { class: 'small' }, el('a', { href: '#/nextgen' }, 'See all NC Metrics →')));
    } catch (err) {
      return el('div', { class: 'notice' }, el('p', { class: 'muted' }, err.message));
    }
  };

  const playerRow = (p) => el('tr', {},
    el('td', { class: 'num' }, p.number ?? ''),
    el('td', {},
      el('div', {}, p.name),
      p.statsTeam ? el('div', { class: 'muted small' }, `Stats from ${p.statsTeam}`) : null),
    el('td', {}, p.pos),
    el('td', {}, p.year),
    el('td', { class: 'num' }, [p.height, p.weight].filter(Boolean).join(' · ')),
    el('td', {}, p.summary || el('span', { class: 'muted' }, 'No stats yet')),
    el('td', {}, p.details.length
      ? el('details', { class: 'player-details' },
          el('summary', {}, 'Full stats'),
          p.details.map((g) => el('div', { class: 'detail-group' },
            el('strong', {}, g.title, g.team ? ` · ${g.team}` : ''),
            el('div', { class: 'mono small' }, g.fields.map((f) => `${f.label} ${f.value}`).join('   ')))))
      : null));

  const loadRoster = async (sport) => {
    try {
      const data = await api(`/api/premium/roster/${program.id}/${sport}`);
      if (data.players.length === 0) return el('div', { class: 'notice' }, el('p', { class: 'muted' }, 'Roster not loaded yet.'));
      return el('div', {},
        el('p', { class: 'muted small mono' }, `${data.players.length} players · ${data.source || 'ESPN'} · updated ${formatDate(data.updatedAt)}`),
        el('div', { class: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {}, ['#', 'Player', 'Pos', 'Class', 'Size', 'Season stats', 'Details'].map((h) => el('th', {}, h)))),
            el('tbody', {}, data.players.map(playerRow)))));
    } catch (err) {
      return el('div', { class: 'notice' }, el('p', { class: 'muted' }, err.message));
    }
  };

  const loadAnalysis = async (sport) => {
    try {
      const data = await api(`/api/premium/analysis/${program.id}/${sport}`);
      return el('div', { class: 'notice' },
        el('p', {}, data.text),
        data.source ? el('p', { class: 'muted small' }, data.source === 'ai' ? 'AI analysis generated from this team’s NC Metrics and roster.' : 'Stats-based analysis from this team’s NC Metrics and roster.') : null);
    } catch (err) {
      return el('div', { class: 'notice' }, el('p', { class: 'muted' }, err.message));
    }
  };

  queueMicrotask(async () => {
    snapshotHost.replaceChildren(await loadSnapshot('football'));
    rosterHost.replaceChildren(await loadRoster('football'));
    analysisHost.replaceChildren(await loadAnalysis('football'));
  });

  return el('div', {},
    el('h2', { class: 'section-title reveal' }, 'NC Metrics snapshot'),
    bindSport(snapshotHost, loadSnapshot),
    snapshotHost,
    el('h2', { class: 'section-title reveal', style: 'margin-top:48px' }, 'Full roster and player stats'),
    bindSport(rosterHost, loadRoster),
    rosterHost,
    el('h2', { class: 'section-title reveal', style: 'margin-top:48px' }, 'Team analysis'),
    bindSport(analysisHost, loadAnalysis),
    analysisHost,
    el('h2', { class: 'section-title reveal', style: 'margin-top:48px' }, 'Team history'),
    program.history.length
      ? el('ul', { class: 'timeline', style: `--c:${program.color}` },
          program.history.map((h) => el('li', { class: 'reveal' },
            el('span', { class: 'year' }, h.year),
            el('p', {}, h.event))))
      : el('div', { class: 'notice' }, el('p', { class: 'muted' }, 'History entries are being verified and will appear here.')));
}

async function nextGenPage() {
  if (!hasTier('elite')) {
    return el('section', { class: 'page container page-enter' },
      el('div', { class: 'page-head' },
        el('p', { class: 'eyebrow' }, 'Elite'),
        el('h1', { class: 'page-title' }, 'NC Metrics')),
      lockedPanel('elite'));
  }
  const data = await api('/api/premium/metrics');
  const host = el('div');
  let sport = 'football';

  const draw = () => {
    const defs = Object.fromEntries(data.definitions[sport].map((d) => [d.key, d]));
    const cols = METRIC_COLUMNS[sport];
    const rows = state.config.programs.map((program) => {
      const team = data.teams.find((t) => t.programId === program.id && t.sport === sport);
      return el('tr', {},
        el('td', {}, el('span', { style: `color:${program.color};font-weight:800` }, program.short)),
        el('td', { class: 'num' }, team ? String(team.gamesCounted) : '—',
          team && team.stale ? el('span', { class: 'stale' }, ` (${team.gamesOnRecord} on record)`) : null),
        ...cols.map((key) => metricCell(defs[key], team ? team.stats[key] : null)));
    });
    const seasonLabel = data.teams.find((t) => t.sport === sport)?.season || '';
    host.replaceChildren(
      sportToggle([['football', 'Football'], ['mens-basketball', "Men's Basketball"]], sport, (next) => {
        sport = next;
        draw();
      }),
      el('p', { class: 'muted small mono', style: 'margin:8px 0 16px' }, `${seasonLabel} · Source: ${data.source}. Updated ${formatDate(data.updatedAt)}.`),
      el('div', { class: 'table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {}, [el('th', {}, 'Program'), el('th', {}, 'Games'), ...cols.map((k) => el('th', {}, defs[k].label))])),
          el('tbody', {}, rows))),
      el('p', { class: 'muted small', style: 'margin-top:12px' }, 'Rank shows where each program sits among the seven programs (1 is best). Games shows how many games ESPN has posted; where the number is short of the record, the newest results are not in the feed yet.'),
      el('h2', { class: 'section-title', style: 'margin-top:40px' }, 'What the numbers mean'),
      el('div', { class: 'grid cols-2' }, data.definitions[sport].map((d) => el('div', { class: 'notice' },
        el('h3', { style: 'font-size:1.05rem' }, d.label),
        el('p', { class: 'muted small' }, d.definition),
        el('p', { class: 'small' }, d.better === 'higher' ? 'Higher is better' : 'Lower is better')))));
  };
  draw();

  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'page-head' },
      el('p', { class: 'eyebrow' }, 'Elite · Exclusive'),
      el('h1', { class: 'page-title' }, 'NC Metrics'),
      el('p', { class: 'lede' }, 'Team metrics for all seven programs, ranked against each other. Built from ESPN’s team and player statistics feeds.')),
    host);
}

// ---------- discussion board ----------

function topicRowNode(topic) {
  return el('li', { 'data-topic-id': topic.id },
    el('a', { class: 'topic-row', href: `#/discuss/${topic.id}` },
      el('div', {},
        el('div', { class: 'title' }, topic.title),
        el('div', { class: 'meta' },
          el('span', {}, topic.author),
          el('span', {}, formatDateTime(topic.createdAt)),
          topic.programId ? el('span', {}, programFor(topic.programId)?.short) : null)),
      el('div', { class: 'count' }, `${topic.replyCount} ${topic.replyCount === 1 ? 'reply' : 'replies'}`)));
}

function composerNotice() {
  if (!state.user) {
    return el('div', { class: 'notice' },
      el('h3', {}, 'Join the conversation'),
      el('p', { class: 'muted' }, 'Log in to reply to topics. Free accounts can reply; Insider and Elite members can start topics.'),
      el('div', { class: 'cta-row' },
        el('a', { class: 'btn primary', href: '#/login' }, 'Log in'),
        el('a', { class: 'btn ghost', href: '#/signup' }, 'Create account')));
  }
  return null;
}

async function discussPage() {
  const topics = await api('/api/topics');
  const list = el('ul', { class: 'topic-list', id: 'topicList' },
    topics.length ? topics.map(topicRowNode) : el('li', { class: 'notice muted' }, 'No topics yet. Start the first one.'));

  const programSelect = el('select', { name: 'programId' },
    el('option', { value: '' }, 'General discussion'),
    state.config.programs.map((p) => el('option', { value: p.id }, `${p.short}: ${p.nickname}`)));

  const form = el('form', {
    class: 'compose-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const button = e.currentTarget.querySelector('button[type=submit]');
      const errorNode = e.currentTarget.querySelector('.form-error');
      const data = Object.fromEntries(new FormData(e.currentTarget));
      setButtonBusy(button, true);
      try {
        const topic = await api('/api/topics', { method: 'POST', body: { title: data.title, body: data.body, programId: data.programId || null } });
        go(`#/discuss/${topic.id}`);
      } catch (err) {
        errorNode.textContent = err.message;
        setButtonBusy(button, false, 'Post topic');
      }
    },
  },
    el('div', { class: 'field' }, el('label', { for: 'topicTitle' }, 'Title'),
      el('input', { id: 'topicTitle', name: 'title', required: true, minlength: '5', maxlength: '140', placeholder: 'What should the network be talking about?' })),
    el('div', { class: 'field' }, el('label', { for: 'topicProgram' }, 'Program'), programSelect),
    el('div', { class: 'field' }, el('label', { for: 'topicBody' }, 'Opening post'),
      el('textarea', { id: 'topicBody', name: 'body', required: true, maxlength: '5000', placeholder: 'Give the context and your take.' })),
    el('p', { class: 'form-error', role: 'alert' }),
    el('button', { class: 'btn primary', type: 'submit' }, 'Post topic'));

  let composer;
  if (!state.user) composer = composerNotice();
  else if (hasTier('insider')) composer = el('div', { class: 'compose' }, el('h2', {}, 'Start a topic'), form);
  else composer = el('div', { class: 'notice' },
    el('h3', {}, 'Replies are open to you'),
    el('p', { class: 'muted' }, 'Free members can reply to any topic. Upgrade to Insider to start your own topics.'),
    el('div', {}, el('a', { class: 'btn primary', href: '#/pricing' }, 'See Insider')));

  const liveIndicator = el('span', { class: 'live-dot' }, 'Live');

  state.live.add((event, data) => {
    if (event !== 'topic' && event !== 'reply') return;
    if (event === 'topic') {
      if (list.querySelector(`[data-topic-id="${data.id}"]`)) return;
      list.querySelector('.muted')?.closest('li')?.remove();
      list.prepend(topicRowNode(data));
      list.firstElementChild.querySelector('.topic-row').classList.add('flash');
    } else {
      const row = list.querySelector(`[data-topic-id="${data.topicId}"]`);
      if (!row) return;
      const count = row.querySelector('.count');
      const n = (Number(count.textContent.match(/\d+/)?.[0]) || 0) + 1;
      count.textContent = `${n} ${n === 1 ? 'reply' : 'replies'}`;
    }
  });

  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'page-head' },
      liveIndicator,
      el('h1', { class: 'page-title' }, 'Discussion'),
      el('p', { class: 'lede' }, 'Topics and replies update live for everyone on the site.')),
    composer,
    list);
}

async function topicPage(id) {
  const topic = await api(`/api/topics/${encodeURIComponent(id)}`);
  const replyList = el('ol', { class: 'replies', id: 'replyList' });
  const appendReply = (reply) => {
    if (replyList.querySelector(`[data-reply-id="${reply.id}"]`)) return;
    replyList.append(el('li', { class: 'reply', 'data-reply-id': reply.id },
      el('div', { class: 'meta' }, el('span', {}, reply.author), el('span', {}, formatDateTime(reply.createdAt))),
      el('p', { class: 'body' }, reply.body)));
  };
  topic.replies.forEach(appendReply);
  if (topic.replies.length === 0) replyList.append(el('li', { class: 'muted' }, 'No replies yet.'));

  let replyBox;
  if (!state.user) {
    replyBox = el('div', { class: 'notice' },
      el('p', { class: 'muted' }, 'Log in to reply.'),
      el('div', { class: 'cta-row' }, el('a', { class: 'btn primary', href: '#/login' }, 'Log in')));
  } else {
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const button = e.currentTarget.querySelector('button[type=submit]');
        const errorNode = e.currentTarget.querySelector('.form-error');
        const textarea = e.currentTarget.querySelector('textarea');
        setButtonBusy(button, true);
        try {
          const reply = await api(`/api/topics/${topic.id}/replies`, { method: 'POST', body: { body: textarea.value } });
          appendReply(reply);
          replyList.querySelector('.muted')?.remove();
          textarea.value = '';
          errorNode.textContent = '';
        } catch (err) {
          errorNode.textContent = err.message;
        } finally {
          setButtonBusy(button, false, 'Post reply');
        }
      },
    },
      el('div', { class: 'field' }, el('label', { for: 'replyBody' }, 'Your reply'),
        el('textarea', { id: 'replyBody', name: 'body', required: true, maxlength: '3000' })),
      el('p', { class: 'form-error', role: 'alert' }),
      el('button', { class: 'btn primary', type: 'submit' }, 'Post reply'));
    replyBox = el('div', { class: 'compose' }, el('h2', {}, 'Reply'), form);
  }

  state.live.add((event, data) => {
    if (event === 'reply' && data.topicId === topic.id) {
      appendReply(data);
      replyList.querySelector('.muted')?.remove();
    }
  });

  const program = topic.programId ? programFor(topic.programId) : null;
  return el('section', { class: 'page container page-enter' },
    el('a', { class: 'btn ghost small-btn', href: '#/discuss' }, '← All topics'),
    el('div', { class: 'page-head', style: 'margin-top:28px' },
      el('div', { class: 'live-dot' }, 'Live'),
      el('h1', { class: 'page-title', style: 'font-size:clamp(2rem,5vw,3.6rem)' }, topic.title),
      el('p', { class: 'muted small mono' }, `${topic.author} · ${formatDateTime(topic.createdAt)}${program ? ` · ${program.short}` : ''}`)),
    el('p', { class: 'thread-body' }, topic.body),
    el('h2', { class: 'section-title' }, `${topic.replies.length} ${topic.replies.length === 1 ? 'reply' : 'replies'}`),
    replyList,
    replyBox);
}

// ---------- pricing & billing ----------

async function activateDemoPlan(plan) {
  await api('/api/billing/demo-upgrade', { method: 'POST', body: { plan } });
  await refreshUser();
  toast(`Demo: ${TIER_LABEL[plan]} is active on this account`);
}

async function startCheckout(plan, button) {
  if (button) setButtonBusy(button, true);
  try {
    const { url } = await api('/api/billing/checkout', { method: 'POST', body: { plan } });
    window.location.href = url;
  } catch (err) {
    toast(err.message);
    if (button) setButtonBusy(button, false, `Choose ${TIER_LABEL[plan]}`);
  }
}

function pricingPage(params) {
  const plans = state.config.plans;
  const current = state.user?.tier || 'free';
  const notice = el('p', { class: 'muted small', role: 'status' });

  const planCards = plans.map((plan) => {
    const isCurrent = current === plan.id;
    const isFeatured = plan.id === 'insider';
    let action;
    if (plan.id === 'free') {
      action = state.user
        ? el('button', { class: 'btn ghost block', type: 'button', disabled: true }, isCurrent ? 'Your plan' : 'Included')
        : el('a', { class: 'btn ghost block', href: '#/signup' }, 'Start free');
    } else if (isCurrent) {
      action = el('button', { class: 'btn ghost block', type: 'button', disabled: true }, 'Your plan');
    } else if (!state.user) {
      action = el('a', { class: 'btn primary block', href: `#/signup?plan=${plan.id}` }, `Choose ${plan.name}`);
    } else if (RANK[current] > RANK[plan.id]) {
      action = el('button', { class: 'btn ghost block', type: 'button', disabled: true }, 'Included in your plan');
    } else if (!state.config.billingEnabled && state.config.demoBilling) {
      action = el('button', {
        class: 'btn primary block',
        type: 'button',
        onclick: async (e) => {
          setButtonBusy(e.currentTarget, true);
          try {
            await activateDemoPlan(plan.id);
            render();
          } catch (err) {
            toast(err.message);
            setButtonBusy(e.currentTarget, false, `Activate ${plan.name} (demo)`);
          }
        },
      }, `Activate ${plan.name} (demo)`);
    } else {
      action = el('button', {
        class: 'btn primary block',
        type: 'button',
        onclick: (e) => {
          if (!state.config.billingEnabled) {
            toast('Payments are not connected yet.');
            return;
          }
          startCheckout(plan.id, e.currentTarget);
        },
      }, `Choose ${plan.name}`);
    }

    return el('article', { class: `plan reveal ${isFeatured ? 'featured' : ''}` },
      isFeatured ? el('span', { class: 'ribbon' }, 'Most popular') : null,
      el('h3', {}, plan.name),
      el('p', { class: 'muted' }, plan.tagline),
      el('div', { class: 'price' },
        el('span', { class: 'amount' }, plan.price === 0 ? 'Free' : `$${plan.price}`),
        plan.price === 0 ? null : el('span', { class: 'per' }, '/ month')),
      el('ul', {}, plan.features.map((f) => el('li', {}, f))),
      action);
  });

  const extras = [];
  if (state.user && current !== 'free') {
    extras.push(el('button', {
      class: 'btn ghost',
      type: 'button',
      onclick: async (e) => {
        try {
          const { url } = await api('/api/billing/portal', { method: 'POST' });
          window.location.href = url;
        } catch (err) { toast(err.message); }
      },
    }, 'Manage billing'));
  }
  if (!state.config.billingEnabled) {
    notice.textContent = state.config.demoBilling
      ? 'Payments are not connected yet. Demo mode is on: the plan buttons switch this account to that plan for local testing.'
      : 'Payments are not connected yet. Add Stripe keys to enable checkout (see README).';
  }

  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'page-head' },
      el('p', { class: 'eyebrow' }, 'Membership'),
      el('h1', { class: 'page-title' }, 'Plans'),
      el('p', { class: 'lede' }, 'Free gets you in the room. Insider gets you the story behind it. Elite gets you the full picture.')),
    el('div', { class: 'plans' }, planCards),
    el('div', { class: 'cta-row plan-note' }, extras),
    notice);
}

// ---------- auth & account ----------

async function refreshUser() {
  const me = await api('/api/auth/me');
  state.user = me.user;
  renderNav();
}

function authPage(mode, params) {
  const isSignup = mode === 'signup';
  const next = params.get('next');
  const plan = params.get('plan');
  const errorNode = el('p', { class: 'form-error', role: 'alert' });

  const fields = [];
  if (isSignup) {
    fields.push(el('div', { class: 'field' }, el('label', { for: 'authName' }, 'Display name (optional)'),
      el('input', { id: 'authName', name: 'displayName', maxlength: '30', autocomplete: 'nickname' })));
  }
  fields.push(
    el('div', { class: 'field' }, el('label', { for: 'authEmail' }, 'Email'),
      el('input', { id: 'authEmail', name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    el('div', { class: 'field' }, el('label', { for: 'authPassword' }, isSignup ? 'Password (8+ characters)' : 'Password'),
      el('input', {
        id: 'authPassword', name: 'password', type: 'password', required: true,
        minlength: isSignup ? '8' : null, autocomplete: isSignup ? 'new-password' : 'current-password',
      })));

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const button = e.currentTarget.querySelector('button[type=submit]');
      const data = Object.fromEntries(new FormData(e.currentTarget));
      setButtonBusy(button, true);
      errorNode.textContent = '';
      try {
        const result = await api(isSignup ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', body: data });
        state.user = result.user;
        renderNav();
        toast(isSignup ? 'Account created. Welcome.' : 'Welcome back.');
        if (plan && ['insider', 'elite'].includes(plan) && !state.config.billingEnabled && state.config.demoBilling) {
          try {
            await activateDemoPlan(plan);
          } catch (err) {
            toast(err.message);
          }
          go('#/account');
          return;
        }
        if (plan && ['insider', 'elite'].includes(plan) && state.config.billingEnabled) {
          try {
            const { url } = await api('/api/billing/checkout', { method: 'POST', body: { plan } });
            window.location.href = url;
            return;
          } catch (err) {
            toast(err.message);
          }
        }
        go(next ? `#/${next.replace(/^\/+/, '')}` : '#/account');
      } catch (err) {
        errorNode.textContent = err.message;
        setButtonBusy(button, false, isSignup ? 'Create account' : 'Log in');
      }
    },
  }, fields, errorNode,
    el('button', { class: 'btn primary block', type: 'submit' }, isSignup ? 'Create account' : 'Log in'));

  const switchHref = isSignup
    ? `#/login${next ? `?next=${encodeURIComponent(next)}` : ''}`
    : `#/signup${plan ? `?plan=${plan}` : ''}`;

  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'auth-card' },
      el('h1', {}, isSignup ? 'Create account' : 'Log in'),
      el('p', { class: 'muted', style: 'margin-bottom:22px' }, isSignup
        ? 'Your account saves your plan and discussion activity.'
        : 'Use the email you signed up with.'),
      form,
      isSignup ? null : el('p', { class: 'auth-switch' }, el('a', { href: '#/forgot' }, 'Forgot your password?')),
      el('p', { class: 'auth-switch' },
        isSignup ? 'Already have an account? ' : 'New here? ',
        el('a', { href: switchHref }, isSignup ? 'Log in' : 'Create an account'))));
}

// Forgot-password and reset screens. The server gives the same answer whether or not the email has an account.
function resetView(mode, params) {
  const token = params.get('token') || '';
  const isForgot = mode === 'forgot';
  const errorNode = el('p', { class: 'form-error', role: 'alert' });
  const notice = el('p', { class: 'muted', role: 'status', style: 'margin:10px 0' });
  const labelFor = () => (isForgot ? 'Send reset link' : 'Set new password');
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, labelFor());
  const fields = isForgot
    ? [el('div', { class: 'field' }, el('label', { for: 'resetEmail' }, 'Email'),
        el('input', { id: 'resetEmail', name: 'email', type: 'email', required: true, autocomplete: 'email' }))]
    : [el('div', { class: 'field' }, el('label', { for: 'newPassword' }, 'New password (8+ characters)'),
        el('input', { id: 'newPassword', name: 'password', type: 'password', required: true, minlength: '8', autocomplete: 'new-password' }))];

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      errorNode.textContent = '';
      const data = Object.fromEntries(new FormData(e.currentTarget));
      setButtonBusy(submit, true);
      try {
        if (isForgot) {
          const result = await api('/api/auth/forgot', { method: 'POST', body: { email: data.email } });
          notice.textContent = result.message;
        } else {
          await api('/api/auth/reset', { method: 'POST', body: { token, password: data.password } });
          toast('Password updated. Log in with your new password.');
          go('#/login');
          return;
        }
      } catch (err) {
        errorNode.textContent = err.message;
      } finally {
        setButtonBusy(submit, false, labelFor());
      }
    },
  }, fields, errorNode, notice, submit);

  const missingToken = !isForgot && !token;
  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'auth-card' },
      el('h1', {}, isForgot ? 'Reset password' : 'Choose a new password'),
      el('p', { class: 'muted', style: 'margin-bottom:22px' }, isForgot
        ? 'We will email a link that works once and expires in one hour.'
        : 'Enter a new password for your account. This signs you out everywhere else.'),
      missingToken
        ? el('p', { class: 'form-error' }, 'This reset link is missing its code. Request a new one.')
        : form,
      el('p', { class: 'auth-switch' }, el('a', { href: '#/login' }, 'Back to log in'))));
}

async function accountPage(params) {
  if (!state.user) {
    return el('section', { class: 'page container page-enter' },
      el('div', { class: 'notice' },
        el('h3', {}, 'You are not logged in'),
        el('div', { class: 'cta-row' }, el('a', { class: 'btn primary', href: '#/login' }, 'Log in'), el('a', { class: 'btn ghost', href: '#/signup' }, 'Create account'))));
  }

  const tier = state.user.tier;
  const status = el('p', { class: 'muted', role: 'status' });
  const checkoutFlag = params.get('checkout');

  if (checkoutFlag === 'success') {
    status.textContent = 'Thanks. Your plan updates within a few seconds.';
    // Stripe's webhook can land a moment after the redirect, so poll briefly.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      await refreshUser();
      if (state.user.tier !== 'free') break;
    }
  }

  const actions = [];
  if (state.user.tier === 'free') {
    actions.push(el('a', { class: 'btn primary', href: '#/pricing' }, 'Upgrade'));
  } else if (state.config.billingEnabled) {
    actions.push(el('button', {
      class: 'btn ghost',
      type: 'button',
      onclick: async (e) => {
        setButtonBusy(e.currentTarget, true);
        try {
          const { url } = await api('/api/billing/portal', { method: 'POST' });
          window.location.href = url;
        } catch (err) {
          toast(err.message);
          setButtonBusy(e.currentTarget, false, 'Manage billing');
        }
      },
    }, 'Manage billing'));
  }
  actions.push(el('button', {
    class: 'btn ghost',
    type: 'button',
    onclick: async () => {
      await api('/api/auth/logout', { method: 'POST' });
      state.user = null;
      renderNav();
      toast('Logged out');
      go('#/');
    },
  }, 'Log out'));

  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'page-head' },
      el('p', { class: 'eyebrow' }, 'Account'),
      el('h1', { class: 'page-title' }, state.user.displayName)),
    el('div', { class: 'account-grid' },
      el('div', { class: 'stat' },
        el('span', { class: 'label' }, 'Email'),
        el('span', { class: 'value', style: 'font-size:1.2rem;font-stretch:100%;font-weight:600' }, state.user.email),
        el('span', { class: 'label', style: 'margin-top:12px' }, 'Current plan'),
        el('span', { class: 'cta-row' }, tierPill(tier), el('span', { class: 'muted small' }, tier === 'free' ? 'Basic access' : tier === 'insider' ? `$${PRICE.insider} / month` : `$${PRICE.elite} / month`))),
      el('div', { class: 'notice' },
        el('h3', {}, 'Your access'),
        el('ul', { class: 'plain muted' },
          el('li', {}, hasTier('insider') ? 'Insider news, NIL snapshots, and topic creation: included' : 'Insider news and topic creation: locked'),
          el('li', {}, hasTier('elite') ? 'Elite rosters, AI analysis, NC Metrics, and history: included' : 'Elite rosters, AI analysis, NC Metrics, and history: locked')),
        status,
        el('div', { class: 'cta-row' }, actions))));
}

function notFoundPage() {
  return el('section', { class: 'page container page-enter' },
    el('div', { class: 'notice' },
      el('h3', {}, 'Page not found'),
      el('p', { class: 'muted' }, 'That page does not exist.'),
      el('div', {}, el('a', { class: 'btn ghost', href: '#/' }, 'Back to home'))));
}

// ---------- router ----------

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { segments, params: new URLSearchParams(queryPart) };
}

async function render() {
  const id = ++state.renderId;
  const { segments, params } = parseRoute();
  const [a, b, c, d] = segments;
  state.live.clear();

  let view;
  try {
    if (!a) view = await homePage();
    else if (a === 'teams') view = teamsPage();
    else if (a === 'sport' && b) view = await sportPage(b);
    else if (a === 'team' && b) view = await teamPage(b, params.get('tab') || 'overview');
    else if (a === 'nextgen') view = await nextGenPage();
    else if (a === 'nc7-live-map') view = nc7Page();
    else if (a === 'pro-sports' && !b) view = await proLandingPage();
    else if (a === 'pro-sports' && b === 'scores') view = await proScoresPage(params);
    else if (a === 'pro-sports' && b && c === 'game' && d) view = await proGamePage(b, d);
    else if (a === 'pro-sports' && b) view = await proTeamPage(b);
    else if (a === 'discuss' && b) view = await topicPage(b);
    else if (a === 'discuss') view = await discussPage();
    else if (a === 'pricing') view = pricingPage(params);
    else if (a === 'login' || a === 'signup') view = authPage(a, params);
    else if (a === 'forgot' || a === 'reset') view = resetView(a, params);
    else if (a === 'account') view = await accountPage(params);
    else view = notFoundPage();
  } catch (err) {
    view = errorView(err);
  }

  if (id !== state.renderId) return; // a newer navigation has started
  app.replaceChildren(view);
  renderNav();
  observeReveals(app);
  initNc7(app);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ---------- motion ----------

const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' })
  : null;

function observeReveals(root) {
  root.querySelectorAll('.reveal').forEach((node) => {
    if (revealObserver) revealObserver.observe(node);
    else node.classList.add('in');
  });
}

function setupPointerGlow() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let frame = null;
  let x = 0;
  let y = 0;
  window.addEventListener('pointermove', (e) => {
    x = e.clientX;
    y = e.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--mx', `${x}px`);
      document.documentElement.style.setProperty('--my', `${y}px`);
      frame = null;
    });
  }, { passive: true });
}

function setupScrollProgress() {
  const bar = document.getElementById('scrollProgress');
  let frame = null;
  const update = () => {
    frame = null;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
    bar.style.setProperty('--p', progress.toFixed(4));
  };
  window.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });
  update();
}

// ---------- live discussion stream ----------

// Discussion updates arrive by polling every five seconds, so they work on serverless hosting too.
const liveSeen = new Set();
let liveSince = Date.now();
let livePrimed = false;

function dispatchLive(event, data) {
  const key = `${event}:${data.id}`;
  if (liveSeen.has(key)) return;
  liveSeen.add(key);
  for (const listener of state.live) listener(event, data);
}

async function pollDiscussion() {
  if (document.visibilityState === 'hidden' || state.live.size === 0) return;
  try {
    const data = await api(`/api/discussion/updates?since=${liveSince - 3000}`);
    liveSince = data.now;
    // The first poll only sets the starting point, so pages don't double-count what they already show.
    if (!livePrimed) { livePrimed = true; return; }
    for (const topic of data.topics) dispatchLive('topic', topic);
    for (const reply of data.replies) dispatchLive('reply', reply);
  } catch {
    /* try again on the next tick */
  }
}

function connectLive() {
  setInterval(pollDiscussion, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollDiscussion();
  });
}

// ---------- boot ----------

async function init() {
  setProRenderer(render);
  const [config, me] = await Promise.all([api('/api/config'), api('/api/auth/me')]);
  state.config = config;
  state.user = me.user;
  renderFooter();

  const toggle = document.getElementById('navToggle');
  toggle.addEventListener('click', () => {
    const open = header.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  window.addEventListener('hashchange', render);
  setupPointerGlow();
  setupScrollProgress();
  connectLive();
  await render();
}

init().catch((err) => {
  app.replaceChildren(errorView(err));
});
