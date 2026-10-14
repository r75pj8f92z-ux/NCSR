// NC Sports Radar: live games, scores, upsets and top performers for the seven programs.
// Data comes from ESPN's public scoreboard and news feeds. Commitments are not covered by a free feed yet.

const ESPN = process.env.ESPN_API_BASE || 'https://site.api.espn.com/apis/site/v2/sports';
const CACHE_MS = 60 * 1000;
const UNRANKED = 99; // ESPN reports unranked teams as 99
const SPORTS = {
  football: { path: 'football/college-football', groups: 80 },
  'mens-basketball': { path: 'basketball/mens-college-basketball', groups: 50 },
};
const STAT_LABELS = { passingYards: 'Passing', rushingYards: 'Rushing', receivingYards: 'Receiving' };

let cache = null;

// Today's date in US Eastern time, the way ESPN keys its scoreboards.
export function easternDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
}

function ranked(value) {
  return value && value < UNRANKED ? value : null;
}

// Converts one ESPN scoreboard event into the fields the radar needs.
export function normalizeGame(event, sport, programsByEspnId) {
  const c = event.competitions[0];
  const teams = c.competitors.map((x) => {
    const program = programsByEspnId.get(String(x.team.id)) || null;
    return {
      espnId: String(x.team.id),
      programId: program ? program.id : null,
      name: x.team.shortDisplayName || x.team.displayName,
      abbr: x.team.abbreviation,
      score: x.score ?? null,
      record: x.records?.[0]?.summary ?? null,
      rank: ranked(x.curatedRank?.current),
      winner: Boolean(x.winner),
    };
  });
  const leaders = (c.leaders || []).map((cat) => {
    const top = cat.leaders?.[0];
    if (!top) return null;
    const teamId = String(top.athlete?.team?.id ?? top.team?.id ?? '');
    const team = teams.find((t) => t.espnId === teamId) || null;
    return {
      category: STAT_LABELS[cat.name] || cat.displayName,
      athlete: top.athlete?.displayName ?? 'Unknown',
      line: top.displayValue,
      yards: typeof top.value === 'number' ? top.value : 0,
      teamName: team ? team.name : null,
      programId: team ? team.programId : null,
    };
  }).filter(Boolean);
  return {
    id: String(event.id),
    sport,
    name: event.shortName || event.name,
    date: event.date,
    state: event.status.type.state, // pre | in | post
    statusText: event.status.type.shortDetail,
    teams,
    isNC: teams.some((t) => t.programId),
    leaders,
  };
}

function matchupScore(game) {
  // Lower is a bigger matchup: the sum of both ranks, with unranked teams counted as 50.
  return game.teams.reduce((sum, t) => sum + (t.rank ?? 50), 0);
}

// Pure logic: turns raw feeds into the radar. Exported so it can be tested without network access.
export function buildRadar({ scoreboards, news, programsByEspnId, date, now = new Date() }) {
  const games = [];
  for (const [sport, data] of Object.entries(scoreboards)) {
    for (const event of data?.events || []) games.push(normalizeGame(event, sport, programsByEspnId));
  }
  const nc = games.filter((g) => g.isNC);

  const tonight = nc
    .filter((g) => g.state !== 'post')
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const finals = nc.filter((g) => g.state === 'post').sort((a, b) => new Date(b.date) - new Date(a.date));
  const latestScore = (finals[0] || nc.filter((g) => g.state === 'in')[0]) || null;

  const biggest = nc.length
    ? nc.reduce((best, g) => (matchupScore(g) < matchupScore(best) ? g : best))
    : null;

  // An upset: a ranked team loses to an unranked team, or a lower-ranked team beats a higher-ranked one.
  const upsets = finals.filter((g) => {
    const winner = g.teams.find((t) => t.winner);
    const loser = g.teams.find((t) => !t.winner);
    if (!winner || !loser || loser.rank === null) return false;
    return winner.rank === null || winner.rank > loser.rank;
  }).map((g) => {
    const winner = g.teams.find((t) => t.winner);
    const loser = g.teams.find((t) => !t.winner);
    return { gameId: g.id, winner: winner.name, winnerRank: winner.rank, loser: loser.name, loserRank: loser.rank, score: `${winner.score}–${loser.score}` };
  });

  const performers = nc.flatMap((g) => g.leaders).sort((a, b) => b.yards - a.yards);
  const trendingAthlete = performers[0] || null;

  const newsItems = (news || [])
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''))
    .slice(0, 6);

  return {
    date,
    asOf: now.toISOString(),
    tonight,
    biggestMatchup: biggest,
    upsets,
    latestScore,
    trendingAthlete,
    latestCommitment: null,
    breakingNews: newsItems,
  };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'NorthCarolinaSportsReport/1.0' } });
  if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
  return res.json();
}

export async function getRadar(programs, { force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const programsByEspnId = new Map(programs.map((p) => [String(p.espnId), p]));
  const date = easternDate();

  const scoreboards = {};
  const sportEntries = Object.entries(SPORTS);
  await Promise.all(sportEntries.map(async ([sport, s]) => {
    try {
      scoreboards[sport] = await getJson(`${ESPN}/${s.path}/scoreboard?groups=${s.groups}&dates=${date}&limit=300`);
    } catch {
      scoreboards[sport] = { events: [] };
    }
  }));

  const newsLists = await Promise.all(programs.flatMap((p) => [
    getJson(`${ESPN}/football/college-football/news?team=${p.espnId}&limit=5`).catch(() => ({ articles: [] })),
  ]));
  const news = [];
  newsLists.forEach((list, i) => {
    const program = programs[i];
    for (const a of list.articles || []) {
      news.push({
        headline: a.headline,
        description: a.description || null,
        published: a.published,
        url: a.links?.web?.href || null,
        programId: program.id,
        source: 'ESPN',
      });
    }
  });

  const seen = new Set();
  const uniqueNews = news.filter((n) => {
    const key = n.url || n.headline;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const data = buildRadar({ scoreboards, news: uniqueNews, programsByEspnId, date });
  cache = { at: Date.now(), data };
  return data;
}
