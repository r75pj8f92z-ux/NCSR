"""Pull rosters, player season stats and team stats from ESPN's public JSON feeds.
Writes data/rosters.json (players with stats) and data/metrics.json (team NC Metrics)."""
import json, urllib.request, concurrent.futures as cf, datetime, sys

ROOT = "/Users/lukedeaton/Library/Application Support/Claude/scratch-workspaces/f19a1a0a-b50b-4ba3-812e-10974604da6f/3e07d072-e815-460a-80e7-93fcbf334eff/scratch-2026-10-03-91467b/nc-sports-network/data/"
TODAY = "2026-10-03"
SPORTS = {"football": "football/college-football", "mens-basketball": "basketball/mens-college-basketball"}
SEASON_YEAR = {"football": 2026, "mens-basketball": 2026}  # ESPN season year: 2026 = 2026 football, 2025-26 basketball
TEAMS = {"unc": 153, "duke": 150, "ncsu": 152, "ecu": 151, "wake": 154, "appstate": 2026, "charlotte": 2429}

def get(url, retries=3):
    import time, urllib.error
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {}
            last = e
        except Exception as e:
            last = e
        time.sleep(0.5 * (attempt + 1))
    raise last

def roster_players(sp, tid):
    d = get(f"https://site.api.espn.com/apis/site/v2/sports/{sp}/teams/{tid}/roster?limit=500")
    out = []
    for g in d.get("athletes", []):
        items = g.get("items") if isinstance(g, dict) and "items" in g else [g]
        for it in items:
            pos = (it.get("position") or {}).get("abbreviation", "")
            exp = (it.get("experience") or {}).get("abbreviation", "")
            hometown = (it.get("birthPlace") or {}).get("displayText")
            out.append({
                "espnId": str(it["id"]),
                "number": int(it["jersey"]) if str(it.get("jersey", "")).isdigit() else None,
                "name": it["fullName"],
                "pos": pos,
                "year": exp,
                "height": it.get("displayHeight"),
                "weight": it.get("displayWeight"),
                "hometown": hometown,
            })
    return out, d.get("team", {}).get("displayName")

def player_stats(sp, pid, season_year):
    d = get(f"https://site.web.api.espn.com/apis/common/v3/sports/{sp}/athletes/{pid}/stats")
    teams = d.get("teams", {})
    groups = {}
    for c in d.get("categories", []):
        for s in c.get("statistics", []):
            if (s.get("season") or {}).get("year") != season_year:
                continue
            fields = list(zip(c.get("labels", []), c.get("names", []), s.get("stats", [])))
            groups.setdefault(c["displayName"], {"teamId": s.get("teamId"), "fields": []})
            groups[c["displayName"]]["fields"] = [
                {"label": lab, "key": key, "value": val} for lab, key, val in fields
            ]
            groups[c["displayName"]]["teamId"] = s.get("teamId")
    team_names = {tid: t.get("displayName") for tid, t in teams.items() if False}
    team_by_id = {str(t.get("id")): t.get("displayName") for t in teams.values()}
    for g in groups.values():
        g["team"] = team_by_id.get(str(g["teamId"]))
    return groups

def _cats(cats):
    out = {}
    for c in cats:
        out[c["name"]] = {s["name"]: {"label": s.get("abbreviation"), "value": s.get("value"),
                                      "display": s.get("displayValue"), "nationalRank": s.get("rank")}
                          for s in c["stats"]}
    return out

def team_stats(sp, tid):
    d = get(f"https://site.api.espn.com/apis/site/v2/sports/{sp}/teams/{tid}/statistics")
    out = _cats(d["results"]["stats"]["categories"])
    opp = d["results"].get("opponent") or []
    if isinstance(opp, dict):
        opp = opp.get("categories", [])
    out["_opponent"] = _cats(opp)
    games = None
    for name, cat in out.items():
        if name != "_opponent" and "gamesPlayed" in cat:
            games = cat["gamesPlayed"]["value"]
            break
    return out, games, (d.get("season") or {}).get("displayName")

# -------- 1) rosters + player stats --------
jobs = [(pid, sport, tid) for pid, tid in TEAMS.items() for sport in SPORTS]
result = {"teams": {}, "sources": {}}
team_meta = {}

def do_team(job):
    pid, sport, tid = job
    sp = SPORTS[sport]
    players, team_display = roster_players(sp, tid)
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        stats = list(ex.map(lambda p: player_stats(sp, p["espnId"], SEASON_YEAR[sport]), players))
    for p, st in zip(players, stats):
        p["stats"] = st
    tstats, games, season_label = team_stats(sp, tid)
    return job, players, team_display, tstats, games, season_label

with cf.ThreadPoolExecutor(max_workers=2) as ex:
    for job, players, team_display, tstats, games, season_label in ex.map(do_team, jobs):
        pid, sport, tid = job
        result["teams"].setdefault(pid, {})[sport] = {"players": players}
        team_meta[(pid, sport)] = {"display": team_display, "teamStats": tstats, "gamesPlayed": games, "season": season_label}
        print(f"{pid:10s} {sport:16s} players={len(players):3d} withStats={sum(1 for p in players if p['stats']):3d} games={games} season={season_label}", file=sys.stderr)

json.dump({"source": "ESPN public roster and athlete statistics feeds", "updatedAt": TODAY, "teams": result["teams"]},
          open(ROOT + "rosters.json", "w"), indent=1, ensure_ascii=False)
json.dump({(f"{k[0]}|{k[1]}"): v for k, v in team_meta.items()}, open("/private/tmp/claude-501/-Users-lukedeaton-Library-Application-Support-Claude-scratch-workspaces-f19a1a0a-b50b-4ba3-812e-10974604da6f-3e07d072-e815-460a-80e7-93fcbf334eff-scratch-2026-10-03-91467b/009891c9-ecaa-41e6-925c-26de8c21b1ef/scratchpad/team_meta.json", "w"), ensure_ascii=False)
print("done", file=sys.stderr)
