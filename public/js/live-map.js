// NCSR Live Map. Leaflet draws the map; every piece of game text is set with textContent.
// Data comes from /api/nc7 and refreshes in place every 20 seconds while the tab is visible.

const NC_BOUNDS = [[33.8, -84.4], [36.7, -75.3]];
const REFRESH_MS = 20000;
const EVENT_LABELS = { 'Touchdown': 'TOUCHDOWN', 'Field goal': 'FIELD GOAL', 'Halftime': 'HALFTIME', 'Final': 'FINAL', 'Score': 'SCORE' };
const TIERS = { free: 0, insider: 1, elite: 2 };

const live = { data: null, instances: new Set(), timer: null, lastFetch: 0, user: undefined, eventsSeen: new Set() };
const pageState = { sport: 'football', filter: 'all', selected: null, tab: 'game', whereOpen: false };

// ---------- small DOM helper (no innerHTML) ----------

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

async function api(path) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

// ---------- formatting ----------

const etTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
const etDay = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const etKey = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const sportName = (id) => (id === 'football' ? 'Football' : "Men's Basketball");
const money = (n) => (n == null ? '—' : String(n));
const scoreText = (s) => (s && s.us != null && s.them != null ? `${s.us} — ${s.them}` : null);

function gameTime(game) {
  if (!game) return '';
  if (game.status === 'upcoming') return /TBD/.test(game.statusText) ? 'Time TBD' : `${etDay(game.start)} · ${etTime(game.start)}`;
  return game.statusText || '';
}

function venueLine(v) {
  if (!v) return 'Venue TBD';
  return [v.name, [v.city, v.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
}

// The marker's three lines follow the team state exactly as the brief describes.
function markerLines(team) {
  const g = team.currentGame;
  if (!g || team.state === 'none') return { main: 'No Game Today', sub: null, state: 'none' };
  const opp = g.opponent.name;
  if (g.status === 'live') return { main: scoreText(g.score) || 'Live', sub: `${g.statusText} · LIVE`, state: 'live' };
  if (g.status === 'final') return { main: scoreText(g.score) || 'Final', sub: 'FINAL', state: 'final' };
  if (g.status === 'postponed') return { main: 'Postponed', sub: null, state: 'none' };
  return { main: `${g.isHome ? 'vs' : 'at'} ${opp}`, sub: /TBD/.test(g.statusText) ? 'Time TBD' : etTime(g.start), state: 'upcoming' };
}

// ---------- filters ----------

function inWeekend(game, win) {
  const day = etKey(game.start);
  return day >= win.start && day <= win.end;
}

function matchesFilter(team, filter, win) {
  if (filter === 'all') return true;
  if (filter === 'live') return team.state === 'live';
  if (filter === 'today') return team.todayGames.length > 0;
  if (filter === 'weekend') return team.games.some((g) => g.status !== 'postponed' && inWeekend(g, win));
  return true;
}

function sportTeams(data, sport) {
  return data?.sports?.[sport]?.teams || [];
}

// ---------- map instances (full page and homepage mini map) ----------

// OpenStreetMap tiles need no key and carry the attribution they require. The dark theme inverts them with CSS.
function tileUrl() {
  return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
}

function createInstance(host, { mini }) {
  if (!window.L) {
    host.replaceChildren(h('div', { class: 'nc7-fallback' }, 'The map could not load. Check your connection and refresh.'));
    return null;
  }
  const theme = document.documentElement.dataset.nc7Theme || 'dark';
  const mapEl = h('div', { class: `nc7-map theme-${theme}`, role: 'application', 'aria-label': 'Map of the seven North Carolina FBS programs' });
  host.replaceChildren(mapEl);
  const map = L.map(mapEl, {
    zoomControl: !mini, attributionControl: !mini, dragging: !mini, scrollWheelZoom: false,
    doubleClickZoom: !mini, touchZoom: !mini, boxZoom: false, keyboard: !mini, minZoom: 4, maxZoom: 10,
  });
  const layer = L.tileLayer(tileUrl(), {
    maxZoom: 19,
    attribution: mini ? '' : '&copy; OpenStreetMap contributors',
  }).addTo(map);
  map.fitBounds(NC_BOUNDS, { padding: [24, 24], animate: false });
  const inst = { host, mini, map, layer, markers: new Map(), routes: new Map(), awayPins: new Map(), lastFitKey: '', theme };
  // Below zoom 8, markers show the school and its score only, so neighbours don't pile on top of each other.
  const compact = () => mapEl.classList.toggle('nc7-compact', mini || map.getZoom() < 8);
  map.on('zoomend', compact);
  compact();
  live.instances.add(inst);
  return inst;
}

function setTheme(theme) {
  document.documentElement.dataset.nc7Theme = theme;
  for (const inst of live.instances) {
    inst.map.getContainer().classList.toggle('theme-dark', theme !== 'light');
    inst.map.getContainer().classList.toggle('theme-light', theme === 'light');
  }
  try { localStorage.setItem('ncsr-map-theme', theme); } catch { /* private mode */ }
}

function teamMarkerNode(team, mini) {
  const info = markerLines(team);
  return h('div', { class: `nc7-marker state-${info.state}`, style: `--c:${team.color}`, role: 'button', tabindex: '0', 'aria-label': `${team.name}: ${info.main}${info.sub ? `, ${info.sub}` : ''}` },
    h('span', { class: 'nc7-badge' }, team.short),
    h('span', { class: 'nc7-main' }, info.main),
    !mini && info.sub ? h('span', { class: 'nc7-sub' }, info.sub) : null);
}

function updateInstance(inst, data, sport, filter, win, onPick) {
  const { map } = inst;
  const teams = sportTeams(data, sport);
  const focus = [];
  const seenTeams = new Set();

  for (const team of teams) {
    const home = team.homeVenue?.coords;
    if (!home) continue;
    seenTeams.add(team.programId);
    const matched = matchesFilter(team, filter, win);
    let entry = inst.markers.get(team.programId);
    if (!entry) {
      const node = teamMarkerNode(team, inst.mini);
      const marker = L.marker([home.lat, home.lng], {
        icon: L.divIcon({ className: 'nc7-icon', html: '<div class="nc7-slot"></div>', iconSize: null, iconAnchor: [0, 0] }),
        keyboard: false,
      }).addTo(map);
      marker.getElement().querySelector('.nc7-slot').appendChild(node);
      marker.on('click', () => onPick(team.programId));
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter') onPick(team.programId); });
      entry = { marker, node, team: team.programId };
      inst.markers.set(team.programId, entry);
    }
    const info = markerLines(team);
    entry.node.className = `nc7-marker state-${info.state}${matched ? '' : ' dim'}${pageState.selected === team.programId && !inst.mini ? ' selected' : ''}`;
    entry.node.style.setProperty('--c', team.color);
    entry.node.setAttribute('aria-label', `${team.name}: ${info.main}${info.sub ? `, ${info.sub}` : ''}`);
    if (!inst.mini) {
      entry.node.replaceChildren(
        h('span', { class: 'nc7-badge' }, team.short),
        h('span', { class: 'nc7-main' }, info.main),
        ...(info.sub ? [h('span', { class: 'nc7-sub' }, info.sub)] : []));
    } else {
      entry.node.replaceChildren(h('span', { class: 'nc7-badge' }, team.short), h('span', { class: 'nc7-main' }, info.main));
    }

    // Away games: a route from the home stadium to the opponent's venue, plus a pin there.
    const g = team.currentGame;
    const awayCoords = g && !g.isHome && g.venueCoords ? g.venueCoords : null;
    const routeKey = awayCoords && matched ? `${team.programId}` : null;
    if (routeKey) {
      const latlngs = [[home.lat, home.lng], [awayCoords.lat, awayCoords.lng]];
      const existing = inst.routes.get(team.programId);
      if (existing) existing.setLatLngs(latlngs);
      else inst.routes.set(team.programId, L.polyline(latlngs, { className: 'nc7-route', color: team.color, weight: 2, opacity: 0.85, interactive: false }).addTo(map));
      const pin = inst.awayPins.get(team.programId);
      const pinHtml = `${g.opponent.name} · ${g.venue?.name || ''}`;
      if (pin) { pin.setLatLng([awayCoords.lat, awayCoords.lng]); pin.setTooltipContent(pinHtml); }
      else {
        const p = L.circleMarker([awayCoords.lat, awayCoords.lng], { radius: 6, color: team.color, weight: 2, fillColor: '#07071A', fillOpacity: 1, className: 'nc7-pin' })
          .bindTooltip(pinHtml, { direction: 'top' }).addTo(map);
        inst.awayPins.set(team.programId, p);
      }
      if (matched) focus.push([awayCoords.lat, awayCoords.lng]);
    } else {
      if (inst.routes.has(team.programId)) { map.removeLayer(inst.routes.get(team.programId)); inst.routes.delete(team.programId); }
      if (inst.awayPins.has(team.programId)) { map.removeLayer(inst.awayPins.get(team.programId)); inst.awayPins.delete(team.programId); }
    }
    if (matched) focus.push([home.lat, home.lng]);
  }

  // Fit the view only when the set of visible games changes, so the map doesn't jump on each refresh.
  const key = `${sport}|${filter}|${focus.map((p) => p.join(',')).sort().join(';')}`;
  if (key !== inst.lastFitKey) {
    inst.lastFitKey = key;
    const allPoints = focus.length ? focus : [];
    const outsideNC = allPoints.some(([lat, lng]) => lat < NC_BOUNDS[0][0] || lat > NC_BOUNDS[1][0] || lng < NC_BOUNDS[0][1] || lng > NC_BOUNDS[1][1]);
    if (allPoints.length && outsideNC) {
      map.flyToBounds(L.latLngBounds(allPoints.concat([NC_BOUNDS[0], NC_BOUNDS[1]])), { padding: [48, 48], maxZoom: 7, duration: 0.9 });
    } else {
      map.flyToBounds(NC_BOUNDS, { padding: [24, 24], duration: 0.9 });
    }
  }
}

function flashEvents(inst, events, sport) {
  for (const ev of events) {
    if (ev.sport !== sport) continue;
    const entry = inst.markers.get(ev.programId);
    if (!entry) continue;
    const node = entry.node;
    node.classList.remove('ev-touchdown', 'ev-field-goal', 'ev-halftime', 'ev-final', 'ev-score');
    void node.offsetWidth; // restart the CSS animation
    const cls = { Touchdown: 'ev-touchdown', 'Field goal': 'ev-field-goal', Halftime: 'ev-halftime', Final: 'ev-final', Score: 'ev-score' }[ev.type] || 'ev-score';
    node.classList.add(cls);
    node.dataset.event = EVENT_LABELS[ev.type] || ev.type.toUpperCase();
    setTimeout(() => node.classList.remove(cls), 4200);
  }
}

// ---------- live refresh ----------

// The repeating refresh pauses while the tab is hidden. The first load always runs.
async function refresh(force = false) {
  if (!force && document.visibilityState === 'hidden') return;
  try {
    live.data = await api('/api/nc7');
    live.lastFetch = Date.now();
    const newEvents = (live.data.events || []).filter((e) => {
      const key = `${e.gameId}|${e.type}|${e.at}`;
      if (live.eventsSeen.has(key)) return false;
      live.eventsSeen.add(key);
      return true;
    });
    renderAll(newEvents);
  } catch {
    markStale();
  }
}

function markStale() {
  for (const el of document.querySelectorAll('[data-nc7-status]')) {
    el.textContent = 'Live feed paused. Showing the last update.';
  }
}

export function startLive() {
  if (live.timer) return;
  live.timer = setInterval(() => {
    for (const inst of [...live.instances]) if (!inst.host.isConnected) live.instances.delete(inst);
    if (!live.instances.size) { clearInterval(live.timer); live.timer = null; return; }
    refresh();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
}

function renderAll(newEvents = []) {
  if (!live.data) return;
  for (const inst of live.instances) {
    if (!inst.host.isConnected) continue;
    const onPick = inst.mini ? () => { location.hash = '#/nc7-live-map'; } : (id) => openPanel(id);
    const win = live.data.window;
    updateInstance(inst, live.data, inst.mini ? 'football' : pageState.sport, inst.mini ? 'all' : pageState.filter, win, onPick);
    if (newEvents.length) flashEvents(inst, newEvents, inst.mini ? 'football' : pageState.sport);
  }
  renderPage();
}

// ---------- homepage module ----------

export function nc7MiniMap() {
  const host = h('div', { class: 'nc7-mini-host', 'data-nc7-mini': '' });
  host.dataset.nc7Init = 'mini';
  return h('section', { class: 'nc7-mini section reveal' },
    h('div', { class: 'row-between' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Live map'),
        h('h2', { class: 'section-title' }, 'NC7 Live Map')),
      h('a', { class: 'btn ghost small-btn', href: '#/nc7-live-map' }, 'Open full map →')),
    h('div', { class: 'nc7-mini-card' },
      host,
      h('p', { class: 'nc7-mini-line', 'data-nc7-line': '' }, 'Loading the live map...')));
}

function liveNowLine(data) {
  const live = [];
  for (const sport of ['football', 'mens-basketball']) {
    for (const t of sportTeams(data, sport)) {
      if (t.state === 'live' && t.currentGame) {
        const g = t.currentGame;
        live.push(`${t.short} ${g.isHome ? '' : '@ '}${g.score.us ?? ''} — ${g.score.them ?? ''} ${g.opponent.abbr}`.replace(/\s+/g, ' ').trim());
      }
    }
  }
  return live.length ? `LIVE NOW: ${live.join('  ·  ')}` : 'No NC7 games live right now.';
}

// ---------- full page ----------

export function nc7Page() {
  const mapHost = h('div', { class: 'nc7-map-host', 'data-nc7-page': '' });
  mapHost.dataset.nc7Init = 'page';
  const summary = h('div', { class: 'nc7-summary', 'data-nc7-summary': '' });
  const controls = h('div', { class: 'nc7-controls', 'data-nc7-controls': '' });
  const cards = h('div', { class: 'nc7-cards', 'data-nc7-cards': '' });
  const lists = h('div', { class: 'nc7-lists', 'data-nc7-lists': '' });
  const panel = h('div', { class: 'nc7-panel-host', 'data-nc7-panel': '' });
  const where = h('div', { class: 'nc7-where-host', 'data-nc7-where': '' });
  const status = h('p', { class: 'muted small mono', 'data-nc7-status': '' }, 'Loading live games...');

  setTimeout(() => { if (live.data) renderPage(); }, 0);
  startLive();

  return h('section', { class: 'page container page-enter nc7-page' },
    h('div', { class: 'nc7-head' },
      h('p', { class: 'eyebrow' }, 'NCSR Live Map'),
      h('h1', { class: 'page-title' }, 'NC7'),
      h('p', { class: 'lede' }, 'Where all seven North Carolina FBS programs are playing, home or away, and how each game stands right now.'),
      status),
    summary,
    controls,
    h('div', { class: 'nc7-stage' },
      mapHost,
      panel),
    where,
    h('div', { class: 'section-title nc7-cards-title' }, 'Game cards'),
    cards,
    lists);
}

export function initNc7(root) {
  if (!document.documentElement.dataset.nc7Theme) {
    let saved = 'dark';
    try { saved = localStorage.getItem('ncsr-map-theme') || 'dark'; } catch { /* private mode */ }
    document.documentElement.dataset.nc7Theme = saved === 'light' ? 'light' : 'dark';
  }
  for (const host of root.querySelectorAll('[data-nc7-init]')) {
    if (host.dataset.nc7Ready) continue;
    host.dataset.nc7Ready = '1';
    const mini = host.dataset.nc7Init === 'mini';
    const inst = createInstance(mini ? host.querySelector('.nc7-mini-host') || host : host, { mini });
    if (!inst) continue;
    if (mini) {
      inst.host.dataset.mini = 'yes';
    }
  }
  if (!live.instances.size) return;
  startLive();
  // Draw whatever is already loaded, then fetch fresh data.
  if (live.data) renderAll();
  refresh(true);
  for (const el of root.querySelectorAll('[data-nc7-line]')) {
    el.textContent = live.data ? liveNowLine(live.data) : 'Loading the live map...';
  }
}

function renderPage() {
  if (!live.data) return;
  const page = document.querySelector('[data-nc7-page]');
  const mini = document.querySelector('[data-nc7-line]');
  if (mini) mini.textContent = liveNowLine(live.data);
  if (!page || !page.isConnected) return;
  const d = live.data;
  const sport = pageState.sport;
  const summaryNode = document.querySelector('[data-nc7-summary]');
  const controlsNode = document.querySelector('[data-nc7-controls]');
  const cardsNode = document.querySelector('[data-nc7-cards]');
  const listsNode = document.querySelector('[data-nc7-lists]');
  const statusNode = document.querySelector('[data-nc7-status]');
  const teams = sportTeams(d, sport);
  const s = d.sports[sport]?.summary || { teams: 7, playingToday: 0, home: 0, away: 0, live: 0, upcoming: 0, final: 0 };

  statusNode.textContent = `Updated ${new Date(d.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' })} ET · ${sportName(sport)} · Refreshes every 20 seconds`;
  const stat = (n, label) => h('div', { class: 'nc7-stat' }, h('span', { class: 'nc7-stat-n' }, String(n)), h('span', { class: 'nc7-stat-l' }, label));
  summaryNode.replaceChildren(
    h('p', { class: 'eyebrow nc7-gameday' }, 'Game Day'),
    h('div', { class: 'nc7-stats' },
      stat(s.teams, 'Teams'), stat(s.away, 'Away'), stat(s.home, 'Home'),
      stat(s.live, 'Live'), stat(s.upcoming, 'Upcoming'), stat(s.final, 'Final')));

  const sportToggle = (value, label) => h('button', { type: 'button', class: 'nc7-pill', 'aria-pressed': String(pageState.sport === value), onclick: () => { pageState.sport = value; pageState.selected = null; renderAll(); } }, label);
  const theme = document.documentElement.dataset.nc7Theme || 'dark';
  const themeBtn = h('button', { type: 'button', class: 'nc7-pill nc7-theme', 'aria-pressed': String(theme === 'light'), onclick: () => { setTheme(theme === 'light' ? 'dark' : 'light'); renderPage(); } }, theme === 'light' ? 'Dark map' : 'Light map');
  const filterBtn = (value, label) => h('button', { type: 'button', class: 'nc7-pill', 'aria-pressed': String(pageState.filter === value), onclick: () => { pageState.filter = value; renderAll(); } }, label);
  controlsNode.replaceChildren(
    h('div', { class: 'nc7-filters', role: 'group', 'aria-label': 'Filter games' },
      filterBtn('all', 'All 7'), filterBtn('live', 'Live now'), filterBtn('today', 'Today'), filterBtn('weekend', 'This weekend')),
    h('div', { class: 'nc7-filters', role: 'group', 'aria-label': 'Choose sport' },
      sportToggle('football', 'Football'), sportToggle('mens-basketball', "Men's Basketball"),
      themeBtn,
      h('button', { type: 'button', class: 'btn primary small-btn nc7-where-btn', onclick: () => { pageState.whereOpen = !pageState.whereOpen; renderPage(); } }, 'Where are the NC7?')));

  const where = document.querySelector('[data-nc7-where]');
  where.replaceChildren(...(pageState.whereOpen ? [whereList(teams)] : []));

  const visible = teams.filter((t) => matchesFilter(t, pageState.filter, d.window));
  cardsNode.replaceChildren(...(visible.length ? visible.map((t) => gameCard(t)) : [h('p', { class: 'muted nc7-empty' }, emptyText(sport))]));

  const panelHost = document.querySelector('[data-nc7-panel]');
  if (pageState.selected) panelHost.replaceChildren(detailPanel(teams.find((t) => t.programId === pageState.selected), sport));
  else panelHost.replaceChildren();

  listsNode.replaceChildren(
    listBlock('Upcoming', upcomingGames(d, sport)),
    listBlock('Recent finals', recentFinals(d, sport)));
}

function emptyText(sport) {
  return sport === 'mens-basketball'
    ? 'No men’s basketball games on the board right now. The season starts in November.'
    : 'No NC7 games match this filter right now.';
}

function gameCard(team) {
  const g = team.currentGame;
  const info = markerLines(team);
  return h('article', { class: `nc7-card state-${info.state}`, style: `--c:${team.color}`, tabindex: '0', role: 'button', 'aria-label': `${team.name} game card`, onclick: () => openPanel(team.programId), onkeydown: (e) => { if (e.key === 'Enter') openPanel(team.programId); } },
    h('div', { class: 'nc7-card-top' },
      h('span', { class: 'nc7-card-team' }, team.name),
      h('span', { class: `nc7-status state-${info.state}` }, info.state === 'live' ? 'Live' : info.state === 'final' ? 'Final' : info.state === 'upcoming' ? 'Upcoming' : 'No game')),
    g ? h('div', { class: 'nc7-card-body' },
        h('p', { class: 'nc7-card-opp' }, `${g.isHome ? 'Home' : 'Away'} · ${g.isHome ? 'vs' : 'at'} ${g.opponent.name}`),
        h('p', { class: 'nc7-card-score' }, scoreText(g.score) || gameTime(g)),
        h('p', { class: 'muted small' }, g.status === 'upcoming' ? gameTime(g) : g.statusText),
        h('p', { class: 'muted small' }, venueLine(g.venue)))
      : h('div', { class: 'nc7-card-body' }, h('p', { class: 'muted small' }, 'No game today.')),
    h('p', { class: 'nc7-card-cta' }, 'Open details →'));
}

function listBlock(title, games) {
  return h('div', { class: 'nc7-list' },
    h('h3', { class: 'nc7-list-title' }, title),
    games.length ? h('ul', { class: 'nc7-list-items' }, games.map((g) => h('li', {},
      h('span', { class: 'nc7-list-main' }, `${g.programShort} ${g.isHome ? 'vs' : 'at'} ${g.opponent.name}`),
      h('span', { class: 'muted small' }, g.status === 'final' ? (scoreText(g.score) || 'Final') : gameTime(g))))) : h('p', { class: 'muted small' }, 'None on the board.'));
}

function upcomingGames(d, sport) {
  const seen = new Set();
  return d.games
    .filter((g) => g.sport === sport && g.status === 'upcoming')
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)))
    .slice(0, 8)
    .map((g) => ({ ...g, programShort: programShort(d, g.programId) }));
}

function recentFinals(d, sport) {
  const seen = new Set();
  return d.games
    .filter((g) => g.sport === sport && g.status === 'final')
    .sort((a, b) => new Date(b.start) - new Date(a.start))
    .filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)))
    .slice(0, 8)
    .map((g) => ({ ...g, programShort: programShort(d, g.programId) }));
}

function programShort(d, id) {
  const t = sportTeams(d, 'football').find((x) => x.programId === id) || sportTeams(d, 'mens-basketball').find((x) => x.programId === id);
  return t ? t.short : id;
}

function whereList(teams) {
  return h('div', { class: 'nc7-where' },
    h('div', { class: 'nc7-where-head' },
      h('p', { class: 'eyebrow' }, 'Right now'),
      h('h2', { class: 'section-title' }, 'Where are the NC7?'),
      h('button', { type: 'button', class: 'btn ghost small-btn', onclick: () => { pageState.whereOpen = false; renderPage(); } }, 'Close')),
    h('ul', { class: 'nc7-where-list' }, teams.map((t) => {
      const g = t.currentGame;
      const line = !g || t.state === 'none' ? 'No game today' : `${g.isHome ? 'Home' : `at ${g.opponent.name}`}${g.isHome ? ` vs ${g.opponent.name}` : ''}`;
      return h('li', { class: `nc7-where-item state-${t.state}`, style: `--c:${t.color}`, role: 'button', tabindex: '0', onclick: () => { pageState.whereOpen = false; openPanel(t.programId); } },
        h('span', { class: 'nc7-where-name' }, t.name),
        h('span', { class: 'muted' }, line),
        h('span', { class: `nc7-status state-${t.state}` }, t.state === 'none' ? 'None' : t.state));
    })));
}

// ---------- detail panel ----------

function openPanel(programId) {
  pageState.selected = programId;
  pageState.tab = 'game';
  renderPage();
  for (const inst of live.instances) {
    const entry = inst.markers.get(programId);
    if (entry && !inst.mini) inst.map.panTo(entry.marker.getLatLng(), { animate: true });
  }
  document.querySelector('[data-nc7-panel]')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function detailPanel(team, sport) {
  if (!team) return h('div');
  const g = team.currentGame;
  const info = markerLines(team);
  const tabs = [['game', 'Game Center'], ['news', 'News'], ['schedule', 'Schedule'], ['stats', 'Stats']];
  const tabBar = h('div', { class: 'nc7-tabs', role: 'tablist' },
    tabs.map(([key, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(pageState.tab === key), class: 'nc7-tab', onclick: () => { pageState.tab = key; renderPage(); } }, label)));
  const body = h('div', { class: 'nc7-tab-body' });
  if (pageState.tab === 'game') body.append(gameCenter(team, g));
  if (pageState.tab === 'news') { body.append(h('p', { class: 'muted' }, 'Loading...')); loadNews(team.programId, body); }
  if (pageState.tab === 'schedule') body.append(scheduleList(team, sport));
  if (pageState.tab === 'stats') { body.append(h('p', { class: 'muted' }, 'Loading...')); loadStats(team, sport, body); }

  return h('aside', { class: 'nc7-panel', style: `--c:${team.color}`, 'aria-label': `${team.name} details` },
    h('div', { class: 'nc7-panel-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, sportName(sport)),
        h('h2', { class: 'nc7-panel-title' }, team.name.toUpperCase()),
        h('p', { class: 'muted small mono' }, team.record ? `${team.record} (as of ${team.recordAsOf ? new Date(`${team.recordAsOf}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'n/a'})` : 'Record not loaded')),
      h('button', { type: 'button', class: 'btn ghost small-btn', onclick: () => { pageState.selected = null; renderPage(); } }, 'Close')),
    h('div', { class: `nc7-panel-line state-${info.state}` },
      h('span', { class: `nc7-status state-${info.state}` }, info.state === 'live' ? 'LIVE' : info.state === 'final' ? 'FINAL' : info.state === 'upcoming' ? 'UPCOMING' : 'NO GAME'),
      h('span', { class: 'nc7-panel-score' }, g ? (scoreText(g.score) ? `${team.short} ${g.score.us} — ${g.score.them} ${g.opponent.abbr}` : `${g.isHome ? 'vs' : 'at'} ${g.opponent.name}`) : 'No game today')),
    g ? h('p', { class: 'muted' }, `${g.statusText}${g.status === 'upcoming' ? '' : ''}`) : null,
    tabBar, body);
}

function gameCenter(team, g) {
  if (!g) {
    const next = team.nextGame;
    return h('div', { class: 'nc7-gc' },
      h('p', {}, 'No game today.'),
      next ? h('p', { class: 'muted' }, `Next: ${next.isHome ? 'vs' : 'at'} ${next.opponent.name}, ${etDay(next.start)} · ${etTime(next.start)}`) : null);
  }
  const events = (live.data?.events || []).filter((e) => e.programId === team.programId && e.gameId === g.id);
  const rows = [
    ['Matchup', `${team.name} ${g.isHome ? 'vs' : 'at'} ${g.opponent.name}${g.opponent.rank ? ` (#${g.opponent.rank})` : ''}`],
    ['Home / away', g.isHome ? 'Home' : 'Away'],
    ['Venue', venueLine(g.venue)],
    ['Game time', g.status === 'upcoming' ? `${etDay(g.start)} · ${etTime(g.start)}` : `${etDay(g.start)} · ${etTime(g.start)}`],
    ['Status', g.statusText || g.status],
  ];
  if (!g.isHome && team.homeVenue?.coords && g.venueCoords) {
    const miles = haversine(team.homeVenue.coords, g.venueCoords);
    rows.push(['Travel', `About ${miles} miles away (straight line)`]);
  }
  return h('div', { class: 'nc7-gc' },
    h('dl', { class: 'nc7-dl' }, rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
    h('p', { class: 'muted small' }, 'Route lines and travel distances are straight-line estimates, not tracking. Not affiliated with any team.'),
    h('h3', { class: 'nc7-subhead' }, 'Recent game events'),
    events.length
      ? h('ul', { class: 'nc7-events' }, events.map((e) => h('li', {}, `${EVENT_LABELS[e.type] || e.type.toUpperCase()} · ${e.scorer === 'us' ? team.short : (g.opponent.abbr || 'Opponent')}`)))
      : h('p', { class: 'muted small' }, 'No scoring events in the last minute and a half. Events appear here as they happen.'));
}

function haversine(a, b) {
  const R = 3958.8; const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

function scheduleList(team, sport) {
  const games = team.games.filter((g) => g.sport === sport || true);
  return h('ul', { class: 'nc7-sched' }, games.map((g) => h('li', { class: `state-${g.status}` },
    h('span', { class: 'nc7-sched-day' }, etDay(g.start)),
    h('span', { class: 'nc7-sched-game' }, `${g.isHome ? 'vs' : 'at'} ${g.opponent.name}`),
    h('span', { class: 'muted small' }, g.status === 'final' ? (scoreText(g.score) || 'Final') : g.status === 'live' ? (scoreText(g.score) || 'Live') : etTime(g.start)))));
}

async function loadNews(programId, body) {
  try {
    const items = await api(`/api/news?program=${encodeURIComponent(programId)}`);
    if (!body.isConnected) return;
    body.replaceChildren(items.length
      ? h('ul', { class: 'nc7-news' }, items.slice(0, 5).map((n) => h('li', {}, h('span', { class: 'nc7-news-t' }, n.title), h('span', { class: 'muted small' }, n.locked ? `${n.tier === 'insider' ? 'Insider' : 'Elite'} story` : n.summary))))
      : h('p', { class: 'muted' }, 'No stories yet.'));
  } catch {
    if (body.isConnected) body.replaceChildren(h('p', { class: 'muted' }, 'News is unavailable right now.'));
  }
}

async function loadStats(team, sport, body) {
  const tier = await currentTier();
  if (!body.isConnected) return;
  if (TIERS[tier] < TIERS.elite) {
    body.replaceChildren(h('div', { class: 'notice' },
      h('p', {}, 'Full team stats are part of NC Metrics for Elite members.'),
      h('a', { class: 'btn primary small-btn', href: '#/pricing' }, 'See Elite')));
    return;
  }
  try {
    const data = await api('/api/premium/metrics');
    const t = data.teams.find((x) => x.programId === team.programId && x.sport === sport);
    if (!t) return body.replaceChildren(h('p', { class: 'muted' }, 'No metrics for this sport yet.'));
    const defs = Object.fromEntries(data.definitions[sport].map((d) => [d.key, d]));
    const keys = Object.keys(t.stats).slice(0, 8);
    body.replaceChildren(h('dl', { class: 'nc7-dl' }, keys.map((k) => {
      const s = t.stats[k];
      const val = s.value == null ? '—' : defs[k]?.unit === 'pct' ? `${s.value.toFixed(1)}%` : s.value;
      return h('div', {}, h('dt', {}, defs[k]?.label || k), h('dd', {}, `${val}${s.rank ? `  (#${s.rank} of 7)` : ''}`));
    })));
  } catch (err) {
    body.replaceChildren(h('p', { class: 'muted' }, err.message));
  }
}

async function currentTier() {
  if (live.user === undefined) {
    try { live.user = (await api('/api/auth/me')).user; } catch { live.user = null; }
  }
  return live.user?.tier || 'free';
}

// Re-export so app.js can set the theme from a button.
export { setTheme };
