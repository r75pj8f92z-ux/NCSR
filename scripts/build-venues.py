"""Fetch every venue on the seven programs' 2026 schedules and geocode it once.
Writes data/venues.json, keyed by "venue name|city|state". Uses OpenStreetMap's Nominatim
(one request per second, as its usage policy asks). Re-run after the schedule changes."""
import json, time, urllib.request, urllib.parse, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
TEAMS = {"unc": 153, "duke": 150, "ncsu": 152, "ecu": 151, "wake": 154, "appstate": 2026, "charlotte": 2429}
SPORTS = {"football": "football/college-football", "mens-basketball": "basketball/mens-college-basketball"}
UA = "NorthCarolinaSportsReport/1.0 (venue geocoding for schedule map)"

def get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(1 + attempt)
    raise RuntimeError(url)

keys = {}
for sport, path in SPORTS.items():
    for pid, tid in TEAMS.items():
        data = get(f"https://site.api.espn.com/apis/site/v2/sports/{path}/teams/{tid}/schedule")
        for ev in data.get("events", []):
            v = ev["competitions"][0].get("venue") or {}
            name = v.get("fullName")
            addr = v.get("address") or {}
            city, state = addr.get("city"), addr.get("state")
            if name:
                keys[f"{name}|{city or ''}|{state or ''}"] = {"name": name, "city": city, "state": state}

out_path = os.path.join(ROOT, "venues.json")
existing = json.load(open(out_path)) if os.path.exists(out_path) else {"venues": {}}
venues = existing.get("venues", {})
for key, v in keys.items():
    if key in venues and venues[key].get("lat") is not None:
        continue
    parts = [v["name"], v["city"] or "", v["state"] or ""]
    query = ", ".join(p for p in parts if p)
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": query, "format": "json", "limit": 1})
    try:
        hits = get(url)
    except Exception:
        hits = []
    time.sleep(1.1)
    if hits:
        venues[key] = {**v, "lat": float(hits[0]["lat"]), "lng": float(hits[0]["lon"]), "geocodedFrom": query}
    else:
        if not query.strip() or (v["city"] and v["state"]):
            # Try city and state alone, so the marker still lands in the right town.
            q2 = ", ".join(p for p in [v["city"] or "", v["state"] or ""] if p)
            if q2:
                hits = get("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": q2, "format": "json", "limit": 1}))
                time.sleep(1.1)
        if hits:
            venues[key] = {**v, "lat": float(hits[0]["lat"]), "lng": float(hits[0]["lon"]), "geocodedFrom": q2, "approximate": True}
        else:
            venues[key] = {**v, "lat": None, "lng": None}
    print(f"{key}: {venues[key].get('lat')}, {venues[key].get('lng')}", file=sys.stderr)

json.dump({"source": "Venues from ESPN team schedules; coordinates from OpenStreetMap Nominatim (ODbL). 'approximate' means city-level.",
           "updatedAt": "2026-10-03", "venues": venues}, open(out_path, "w"), indent=1, ensure_ascii=False)
missing = [k for k, v in venues.items() if v.get("lat") is None]
print(f"venues: {len(venues)}, without coordinates: {len(missing)}", file=sys.stderr)
