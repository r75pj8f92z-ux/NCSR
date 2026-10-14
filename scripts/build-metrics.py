import json
META = json.load(open("team_meta.json"))
ROOT = "/Users/lukedeaton/Library/Application Support/Claude/scratch-workspaces/f19a1a0a-b50b-4ba3-812e-10974604da6f/3e07d072-e815-460a-80e7-93fcbf334eff/scratch-2026-10-03-91467b/nc-sports-network/data/"
PIDS = ["unc", "duke", "ncsu", "ecu", "wake", "appstate", "charlotte"]

# (key, label, plain-English definition, group, path, direction, unit)
# path: (scope, category, stat) where scope is "" for own team or "_opponent" for defense
FOOTBALL = [
 ("ptsPerGame", "Points per game", "Points scored per game.", "Offense", ("", "scoring", "totalPointsPerGame"), "high", "num"),
 ("ptsAllowedPerGame", "Points allowed per game", "Points allowed per game (opponent scoring).", "Defense", ("_opponent", "scoring", "totalPointsPerGame"), "low", "num"),
 ("passYpg", "Passing yards per game", "Net passing yards per game.", "Offense", ("", "passing", "netPassingYardsPerGame"), "high", "num"),
 ("rushYpg", "Rushing yards per game", "Rushing yards per game.", "Offense", ("", "rushing", "rushingYardsPerGame"), "high", "num"),
 ("compPct", "Completion %", "Share of pass attempts completed.", "Offense", ("", "passing", "completionPct"), "high", "pct"),
 ("ydsPerPass", "Yards per pass attempt", "Net passing yards per attempt.", "Offense", ("", "passing", "yardsPerPassAttempt"), "high", "num"),
 ("ydsPerRush", "Yards per rush attempt", "Rushing yards per carry.", "Offense", ("", "rushing", "yardsPerRushAttempt"), "high", "num"),
 ("thirdDownPct", "3rd-down conversion %", "Share of third-down plays converted.", "Offense", ("", "miscellaneous", "thirdDownConvPct"), "high", "pct"),
 ("oppThirdDownPct", "Opponent 3rd-down %", "Share of opponents' third-down plays converted.", "Defense", ("_opponent", "miscellaneous", "thirdDownConvPct"), "low", "pct"),
 ("takeaways", "Takeaways", "Interceptions and fumbles recovered by the defense.", "Defense", ("", "miscellaneous", "totalTakeaways"), "high", "num"),
 ("giveaways", "Giveaways", "Turnovers committed by the offense.", "Offense", ("", "miscellaneous", "totalGiveaways"), "low", "num"),
 ("turnoverMargin", "Turnover margin", "Takeaways minus giveaways.", "Overall", ("", "miscellaneous", "turnOverDifferential"), "high", "num"),
 ("sacks", "Sacks (defense)", "Quarterback sacks by the defense.", "Defense", ("", "defensive", "sacks"), "high", "num"),
 ("sacksAllowed", "Sacks allowed", "Times the offense's quarterbacks were sacked.", "Offense", ("", "passing", "sacks"), "low", "num"),
]
BASKETBALL = [
 ("ptsPerGame", "Points per game", "Points scored per game.", "Offense", ("", "offensive", "avgPoints"), "high", "num"),
 ("fgPct", "Field goal %", "Share of field goals made.", "Offense", ("", "offensive", "fieldGoalPct"), "high", "pct"),
 ("threePct", "Three-point %", "Share of three-pointers made.", "Offense", ("", "offensive", "threePointFieldGoalPct"), "high", "pct"),
 ("ftPct", "Free throw %", "Share of free throws made.", "Offense", ("", "offensive", "freeThrowPct"), "high", "pct"),
 ("apg", "Assists per game", "Assists per game.", "Offense", ("", "offensive", "avgAssists"), "high", "num"),
 ("topg", "Turnovers per game", "Turnovers committed per game.", "Offense", ("", "offensive", "avgTurnovers"), "low", "num"),
 ("astTo", "Assist-to-turnover ratio", "Assists divided by turnovers.", "Offense", ("", "general", "assistTurnoverRatio"), "high", "num"),
 ("rpg", "Rebounds per game", "Total rebounds per game.", "Rebounding", ("", "general", "avgRebounds"), "high", "num"),
 ("spg", "Steals per game", "Steals per game.", "Defense", ("", "defensive", "avgSteals"), "high", "num"),
 ("bpg", "Blocks per game", "Blocks per game.", "Defense", ("", "defensive", "avgBlocks"), "high", "num"),
 ("fouls", "Fouls per game", "Personal fouls per game.", "Defense", ("", "general", "avgFouls"), "low", "num"),
]
DEFS = {
 "football": FOOTBALL, "mens-basketball": BASKETBALL,
}

def value_at(team_stats, scope, cat, stat):
    if scope == "_opponent":
        root = team_stats.get("_opponent", {})
    else:
        root = team_stats
    entry = (root.get(cat) or {}).get(stat)
    if not entry or entry.get("value") is None:
        return None, None
    return float(entry["value"]), entry.get("nationalRank")

out = {"updatedAt": "2026-10-03", "source": "ESPN public team statistics feed (site.api.espn.com), pulled 2026-10-03; football reflects games ESPN had posted at pull time",
       "definitions": {}, "teams": {}}
for sport, defs in DEFS.items():
    out["definitions"][sport] = [{"key": k, "label": l, "definition": d, "group": g, "better": ("higher" if dr == "high" else "lower"), "unit": u}
                                 for k, l, d, g, _, dr, u in defs]
    # gather values per metric
    values = {}
    for pid in PIDS:
        meta = META[f"{pid}|{sport}"]
        ts = meta["teamStats"]
        for key, label, _, _, path, dr, u in defs:
            v, nat = value_at(ts, *path)
            values.setdefault(key, {})[pid] = (v, nat)
    # ranks among the seven programs (1 = best)
    for pid in PIDS:
        meta = META[f"{pid}|{sport}"]
        ts = meta["teamStats"]
        stats = {}
        for key, label, _, _, path, dr, u in defs:
            v, nat = values[key][pid]
            if v is None:
                stats[key] = {"value": None, "rank": None, "nationalRank": None}
                continue
            vals = [x for x, _ in values[key].values() if x is not None]
            better = (lambda a, b: a > b) if dr == "high" else (lambda a, b: a < b)
            rank = 1 + sum(1 for x in vals if better(x, v))
            stats[key] = {"value": round(v, 2), "rank": rank, "nationalRank": nat}
        out["teams"].setdefault(pid, {})[sport] = {
            "season": meta["season"] if sport == "football" else "2025-26 season (last completed)",
            "gamesCounted": meta["gamesPlayed"],
            "stats": stats,
        }
json.dump(out, open(ROOT + "metrics.json", "w"), indent=1, ensure_ascii=False)
print("wrote metrics.json")
for pid in PIDS:
    f = out["teams"][pid]["football"]["stats"]
    print(pid, "pts/g", f["ptsPerGame"], "allowed", f["ptsAllowedPerGame"], "games", out["teams"][pid]["football"]["gamesCounted"])
