# North Carolina Sports Report

Insider coverage of North Carolina college football and men's basketball: UNC, Duke, NC State, East Carolina, Wake Forest, Appalachian State, and Charlotte.

## Plans

| Plan | Price | Includes |
| --- | --- | --- |
| Free | $0 | Basic news for all seven programs, program updates, and the discussion board (reply to any topic) |
| Insider | $5/mo | Everything in Free, plus insider reports, NIL snapshots, and the ability to start topics |
| Elite | $20/mo | Everything in Insider, plus full rosters for every program, AI-assisted team analysis, and team history |

Access is enforced on the server. Locked content is never sent to lower plans.

## Data and sources (as of Oct. 3, 2026)

| Data | Where it comes from | Where it lives |
| --- | --- | --- |
| Head coaches, 2026 records, game results | Official school athletics sites where they were readable, plus Wikipedia's 2026 season pages | `data/content.json` (`programs[].sports`) |
| Rosters, all players, numbers, positions, class, and player season stats | ESPN roster and athlete statistics feeds | `data/rosters.json` |
| News and insider reports | Articles from Sports Illustrated, Yahoo Sports, WRAL, The Appalachian, WCYB, school athletics sites, 247Sports, CBS Sports, On3 | `data/content.json` (`news`). Each item links to its source. |
| NIL figures | Two third-party estimates only: football roster-cost estimates for UNC, Duke, NC State and Wake Forest (nil-ncaa.com), and a CBS Sports roster valuation for UNC basketball. Shown as estimates, not verified NIL totals. | `programs[].insider.nil` |

Records and the NIL figures change often. Before launch and after each game week, re-check them and update `recordAsOf`/`asOf` dates. Rosters should be refreshed each season. These sources are copyrighted in full, so the site only shows short summaries with links to the originals.

## Pro Sports (Panthers, Hornets, Hurricanes)

A premium editorial section for North Carolina's three major pro teams: the Carolina Panthers (NFL), Charlotte Hornets (NBA) and Carolina Hurricanes (NHL). It has its own visual register — dark editorial bands, white reading-surface cards, a single bold red accent, tabular scores — inside the site's existing header, footer and routing, not a second site bolted on.

**Pages:** `#/pro-sports` (landing), `#/pro-sports/panthers`, `#/pro-sports/hornets`, `#/pro-sports/hurricanes` (team hubs), `#/pro-sports/scores` (schedules and full league standings), `#/pro-sports/:team/game/:id` (game preview or recap). Each page updates its title and scoreboard every 30 seconds while open, without a reload.

### An honest choice about the news feed

NC Sports Report has no newsroom of its own yet for these three teams. Rather than invent articles, bylines, quotes or storylines — which the brief for this section explicitly rules out — the feed aggregates ESPN's own published reporting for each team and links back to the full story on ESPN, with "Reporting by ESPN" on every card. That is why there is no in-site article body: republishing ESPN's copyrighted article text would be a copyright problem, and the API doesn't return the full body anyway, only a headline, a short description and an image.

What is real, not approximated:
- **Scores, records and standings** come straight from ESPN's team, schedule, scoreboard and standings feeds.
- **"Latest news" is ESPN's own reporting**, filtered to stories actually about that team (not 32-team round-ups) and ranked so the most specific story leads. A light keyword heuristic sorts stories into Game Recap, Game Preview, Injury Update, Transactions, Draft, Analysis, Team News or League News — it's a filtering aid, not a verified editorial category, and it's disclosed as such in the code.
- **Game pages** use the real matchup, score, venue, kickoff time, and ESPN's own recap text and links (Gamecast, Recap, Preview, Box Score) when ESPN has published them.
- **Team and opponent logos** are ESPN's official logo images, served from ESPN's CDN the same way the data itself is. When a story has no photo, or an image fails to load, the page shows a clean team-colored monogram instead of a broken image or a stock photo standing in for one.
- **The breaking-news banner** only renders when a story is actually flagged breaking. Nothing in the current feed is flagged that way, so it renders nothing — by design, not a bug. There is no newsroom process yet to set that flag; wiring one up is a reasonable next step once there's an editor.

### Scope decisions

- **Scores & Schedules covers the three teams NC Sports Report follows**, not a full 32-team NFL/96-team-ish browser. The brief's "separate views for NFL/NBA/NHL" is met as league standings tabs, since this site exists to follow Carolina's teams, not to replace ESPN.com.
- **Standings are shown at the conference level** with the Panthers/Hornets/Hurricanes row highlighted, because ESPN's standings feed doesn't break out NFL/NBA divisions as separate sub-tables at this endpoint; each team's division position is still shown on its own hub and dashboard via ESPN's `standingSummary` field (e.g., "1st in NFC South").
- **Player statistics** (passing/rushing/receiving, points/rebounds/assists, goals/saves) appear only where ESPN's own game data includes them (the "leaders" on a finished or live game). Full season player stat pages are not built; building them without inventing numbers would need a licensed stats provider.

### Data sources and caching

Backend module: `pro.js`. Team config, score/standings formatting per sport, article ranking and the light categorizer are all pure, exported functions with their own tests in `tests/pro.test.mjs`. Server route: `GET /api/pro`, cached 20 seconds.

| Data | ESPN endpoint | Cache |
| --- | --- | --- |
| Team record, division standing, logo | `site/{sport}/teams/{id}` | 5 min |
| Schedule (every game this season) | `site/{sport}/teams/{id}/schedule` | 5 min |
| Live score override | `site/{sport}/scoreboard?dates=` | 20 sec |
| League standings | `site.web.api/{sport}/standings` | 15 min |
| Team news | `site/{sport}/news?team={id}` | 5 min |

Set `ESPN_API_BASE` and `ESPN_WEB_API_BASE` to point this module at a different source; the tests use a fake ESPN, so they run without a network connection.

## NCSR Live Map

A map of the seven NC FBS programs, centred on North Carolina. Each school has a marker showing its current state: no game today, upcoming, live, or final. Away games draw a dashed route to the opponent's venue.

- **Page:** `#/nc7-live-map` (the site uses hash routes, so the full address is `/#/nc7-live-map`). It has the Game Day summary, filters (All 7, Live now, Today, This weekend, Football, Men's basketball), the map, a "Where are the NC7?" list, game cards, upcoming games, and recent finals.
- **Homepage:** a small map with a "LIVE NOW" line and an "Open full map" link.
- **Detail panel:** Game Center (venue, time, status, straight-line travel distance, recent events), News, Schedule, and Stats. Stats are part of Elite.
- **Refresh:** every 20 seconds, in place, with no page reload. The first load always runs, even in a background tab.

**Data**
- Schedules and live scores come from ESPN's public team schedule and scoreboard feeds (`/api/nc7`). The scoreboard overrides the schedule for live games.
- Venue coordinates come from `data/venues.json`, built by `scripts/build-venues.py` from OpenStreetMap's Nominatim (ODbL). Re-run it when the schedule changes.
- Events are detected by comparing one refresh with the last. Field goals (3 points) and touchdowns (6 to 8 points, football only) are labelled, and so are halftime and the final whistle. Turnovers aren't in ESPN's scoreboard, so the map doesn't show them.
- Travel distance is straight-line, not road or flight distance. Routes are decorative. Nothing tracks players, coaches, buses or aircraft.

**Limits**
- Men's basketball shows nothing until its schedule is posted (the season starts in November).
- Map tiles come from OpenStreetMap, which needs no key and must stay credited. For heavy traffic, switch `tileUrl` in `public/js/live-map.js` to a paid tile provider.
- Leaflet is loaded from cdnjs with pinned integrity hashes. The Content Security Policy allows only that script host and the OpenStreetMap tile host.
- If ESPN is unreachable, the affected teams drop out and the page says the live feed is paused. No placeholder game data is shown.

## NC Sports Radar (homepage module)

A live panel on the homepage with seven cards: games tonight, biggest matchup, upset alerts, latest commitment, latest score, trending athlete, and breaking news. It refreshes every minute.

| Card | How it's built | Limits |
| --- | --- | --- |
| Games tonight | North Carolina games on today's ESPN scoreboard that haven't finished | Football and men's basketball. Basketball shows nothing until its season starts. |
| Biggest matchup | The NC game with the best combined ranking (unranked teams count as 50) | Only covers games on today's board |
| Upset alerts | Finished NC games where an unranked team beat a ranked one, or a lower-ranked team beat a higher one | ESPN betting odds aren't in the feed, so upsets are judged by ranking only |
| Latest commitment | Not connected | Recruiting data needs a licensed feed. The card says so. |
| Latest score | Most recent finished or live NC game | |
| Trending athlete | The top yardage performance among NC games today (passing, rushing or receiving) | Based on ESPN's game leaders |
| Breaking news | Latest ESPN stories for the seven programs, de-duplicated | Stories link to ESPN |

Source: ESPN's public scoreboard and team news feeds, cached for one minute on the server. Set `ESPN_API_BASE` to point the module at another feed. The tests use a fake ESPN, so they run without a network connection.

## Elite package (what each part is and where it comes from)

| Elite feature | What it shows | Source and limits |
| --- | --- | --- |
| NC Metrics | Team metrics for all seven programs, ranked against each other: points for and against, passing and rushing yards, completion %, yards per attempt, third-down rates, turnover margin, sacks. Basketball: scoring, shooting, rebounding, assists, turnovers, steals, blocks. | ESPN public team statistics feed, pulled Oct. 3, 2026. Football counts only games ESPN has posted; the page shows the count next to each team and flags any short of its record. |
| Full roster and player stats | Every player on each roster with position, class, size, and a season stat line. A details panel lists every stat ESPN reports. | ESPN roster and athlete statistics feeds. Basketball shows 2025-26 stats. Players who transferred show their previous team. |
| Team analysis | A plain-language breakdown per team: where it ranks among the seven, its top-two strengths, bottom-two concerns, and roster makeup. | Built from the metrics above. With `ANTHROPIC_API_KEY` set, Claude writes the analysis from the same data (no outside facts). Without a key, the stats-based summary is shown. |
| Team history | National basketball titles for UNC, Duke and NC State. | Verified entries only. Other programs will be added as entries are verified. |

### What is not included

- **Next Gen Stats as the NFL publishes them** (player tracking, separation, expected points). Those come from the NFL's tracking system and cannot be licensed or republished without a data agreement. NC Metrics is built from public team and player stats instead, and is labeled that way on the site.
- **Points allowed, yards allowed and red-zone rates for football teams** are not reported by ESPN in a reliable form for this season, so they are not shown.
- **Live AI analysis** requires your own `ANTHROPIC_API_KEY`. Until it is set, the analysis is the stats-based summary.

### Refreshing the Elite data

Re-run the ESPN pull and rebuild the metrics after each game week. 
1. `python3 scripts/fetch-espn.py` writes `data/rosters.json` and a team-stats cache.
2. `python3 scripts/build-metrics.py` writes `data/metrics.json` from that cache.
3. Check the `updatedAt` dates in both files.

The scripts use ESPN's public feeds, so no key is needed. Their paths point at the original project location, so update the `ROOT` and cache paths if you move the project.

### Not yet populated

- **Team history beyond men's basketball titles:** UNC, Duke and NC State have verified national-title entries. Other programs have no entries yet.

## Run it

Requires Node.js 22.13 or newer.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 70 checks: API, plan gating, discussion, rosters, NC Metrics, Stripe checkout/webhooks, AI analysis
                   # Stripe and the AI model are stood in by local mocks, so tests need no keys or network
```

### Testing Elite locally

Payments are off until Stripe is connected, so Elite has to be switched on in demo mode:

```bash
npm run start:demo   # same as: DEMO_BILLING=1 npm start
```

1. Open http://localhost:3000 and create an account (or log in).
2. Go to **Plans**. Click **Activate Insider (demo)** or **Activate Elite (demo)**. The account changes plan immediately.
3. Elite pages: **NC Metrics**, a team's **Elite** tab (full roster, stats, analysis, history).

Demo mode is ignored when `NODE_ENV=production`, so it cannot grant plans on a live site.
If you start the server with plain `npm start`, no demo buttons appear. That is the usual cause of "I can't get to Elite."


## Connect payments (Stripe)

1. Create two recurring monthly prices in Stripe: $5 and $20.
2. Add a webhook endpoint at `https://YOUR-DOMAIN/api/billing/webhook`. Subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`.
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_INSIDER`, `STRIPE_PRICE_ELITE`, and `PUBLIC_URL`. See `.env.example`.
4. Test with Stripe test keys and test cards first. Never put live keys in the repository.
5. To receive webhooks on your machine during testing, run the Stripe CLI:

   ```bash
   stripe listen --forward-to localhost:3000/api/billing/webhook
   ```

   Use the signing secret it prints as `STRIPE_WEBHOOK_SECRET` for that session.

Checkout, the customer portal, and plan changes are covered by `tests/payments.test.mjs`. Those tests use a local stand-in for Stripe, so a live test-mode run is still needed before launch.

## Deploy to Vercel

The site is a static front end (`public/`) plus an Express API that Vercel runs as one serverless function (`api/[...path].js`). The database is Postgres.

1. **Create the database.** In the Vercel dashboard, open your project's Storage or Marketplace, add a Postgres database (Neon), and copy its connection string. Keep `sslmode=require`.
2. **Import the project** from this folder or its repository. Vercel reads `vercel.json`: static output is `public/`, and the API function bundles `data/`.
3. **Set environment variables** (Project Settings > Environment Variables, Production): `DATABASE_URL`, `PUBLIC_URL` (your `https://` address), `NODE_ENV=production`, and the Stripe, Resend and Anthropic values from `.env.example`. Don't set `DEMO_BILLING`.
4. **Deploy.** The first request creates the database tables automatically.
5. **Connect Stripe.** Point a webhook at `https://YOUR-DOMAIN/api/billing/webhook` and send it the four subscription and checkout events listed above. Test a real test-mode payment before using live keys. Vercel must pass the raw request body to the webhook. If it doesn't, the webhook returns 400 and no plan changes. Check this with the Stripe dashboard's test event.
6. **Connect email.** Verify your sending domain with Resend, then set `RESEND_API_KEY` and `MAIL_FROM`. Without it, password reset emails aren't sent in production.

Local testing still uses `npm run start:demo` with `DATABASE_URL` set to a local Postgres. Tests create their own throwaway databases, using `TEST_DATABASE_ADMIN_URL` (defaults to a local Postgres on port 54329).

## Security

- **Passwords:** salted scrypt hashes. Login and reset return the same message whether or not an account exists.
- **Sessions:** random tokens in HttpOnly, SameSite=Lax, Secure (production) cookies. The database keeps only a hash of each token.
- **Password reset:** one-hour, single-use links, stored as hashes. A successful reset signs the account out everywhere.
- **Rate limits:** 20 sign-in, sign-up and reset attempts per 15 minutes per address, stored in Postgres so they hold across instances.
- **Cross-site requests:** state-changing requests from another origin are refused.
- **Payments:** Stripe Checkout hosts the card form, so the site never sees card numbers. Webhooks are accepted only with a valid Stripe signature and a fresh timestamp.
- **Data:** every query is parameterised. Responses don't include stack traces. Email addresses appear only to their owner.
- **Headers:** HSTS, a Content Security Policy, frame blocking, no MIME sniffing, and restricted referrers and permissions.

Automated checks: `npm test` runs 60 checks, including the security checks in `tests/security.test.mjs`. `npm audit` reports no known vulnerabilities.

**Not yet covered.** These need decisions or accounts from you before a public launch:
- A professional security review or penetration test. Automated tests don't replace one.
- Email verification at sign-up, two-factor sign-in, and bot protection (e.g. Cloudflare Turnstile) on sign-up.
- A Privacy Policy and Terms of Use, reviewed by a lawyer.
- Backups and a restore test for the Postgres database, and error monitoring.

## Launch checklist

- [ ] Add the X, Facebook, YouTube, and TikTok links in `data/content.json` (`social`) if you have them. Only Instagram (`@ncsrnetwork`) is set so far.
- [ ] Add `ANTHROPIC_API_KEY` if you want Claude-written team analysis.
- [ ] Stripe test-mode run-through with `stripe listen`: sign up, pay for Insider and Elite with a test card, cancel in the portal, and confirm the plan changes both ways.
- [ ] Re-check records, coaches, and news dates. Remove any stories older than the coverage window.
- [ ] Set `NODE_ENV=production`, `PUBLIC_URL`, and `DATABASE_URL` on the host.
- [ ] Turn on database backups and test a restore.
- [ ] Decide on your legal page and terms of use before taking payments.

## Known gaps

- No password reset or email verification. These need an email provider.
- No moderation tools on the discussion board yet.
- Rate limiting is per process and resets on restart.
- SQLite runs on one server. Move to Postgres before running more than one instance.
- Content changes need a restart. Keep a copy of `data/` under version control.

## Project layout

```
app.js              Express API: auth, sessions, password reset, tier-gated content, discussion, premium data, radar, map
server.js           Local server: serves public/ and listens
api/[...path].js    Vercel entry point for the API
radar.js            NC Sports Radar: ESPN scoreboard and news, turned into the homepage module
nc7.js              NCSR Live Map: schedules, live scores, team states, travel routes, event detection
public/js/live-map.js  Live map page, homepage mini map, markers, panel, filters, refresh
pro.js              Pro Sports: Panthers/Hornets/Hurricanes record, schedule, standings, news
public/js/pro-sports.js  Pro Sports landing, team hubs, scores & standings, game pages
billing.js          Stripe Checkout, customer portal, signed webhooks
db.js               Postgres pool and schema (created on first use)
mail.js             Password-reset email through Resend
vercel.json         Vercel config: static output and API function
data/content.json   Programs, coaches, records, NIL, news with sources, plans, social links
data/rosters.json   Full rosters with player season stats (ESPN)
data/metrics.json   Team NC Metrics for both sports, with ranks (ESPN)
public/             Front end: index.html, css/styles.css, js/app.js, img/logo.png, img/logo-mask.png
tests/              API, payments, NC Metrics, NC Sports Radar, NCSR Live Map, Pro Sports and security tests
Dockerfile          Container build
scripts/            ESPN data pull, metrics build, and venue geocoding (refresh steps in README)
```
