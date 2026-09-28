# Scout Engine app

Startup scouting for accelerators, incubators and investors: a local prototype of the scouting pipeline, served by `server.js`.

- `dashboard.html`: the signed-in home, with past runs and the way into a new search.
- `search.html`: the six-step pipeline.

The public landing page lives in the separate `ScoutEngine` site repo (GitHub Pages). Nothing in this project is deployed; it runs on your machine with your own API keys.

## The pipeline

Six steps, one tab each on `search.html`:

1. **Search.** One Google query limited to LinkedIn company pages (`site:nl.linkedin.com/company "circular economy" Amsterdam ...`) with an optional company-size clause and a "first seen since" date. A discovery agent then plans its own key terms (local language, adjacent terms, nearby places, startup framing, anything in your brief), shows the plan as a numbered list, runs it in order with live counts, and adds a couple of adaptive queries at the end. Results are deduped by LinkedIn slug.
2. **First pass.** Each company's public LinkedIn page gives its logo, tagline, description, size, founded year, HQ, industry and type. Deterministic rules eliminate consultancies, networks, nonprofits and the like. The model scores logo, name and description and writes a one-line summary and USP for every company.
3. **Review unsure.** Confirm or unconfirm the unsure ones. Any row can be overridden.
4. **Passed first pass.** The survivors, with CSV export.
5. **Second pass.** Each website is fetched and screenshotted with headless Chrome. The domain, founder titles, menu pages, calls to action, colours and rounded shapes are checked, and the model judges the screenshot against the rubric and picks a category.
6. **Ranked report.** Startups ranked by a weighted score. For each one the founders are looked up: a LinkedIn people search (`site:linkedin.com/in "<company>" founder OR CEO`) plus the website's team and contact pages, reconciled by the model into names, roles, LinkedIn profile URLs and emails. Only URLs and addresses that appear in the evidence are kept, so nothing is invented. Then an executive summary and next steps from the model, a funnel, and an appendix of everything eliminated with reasons. Download as HTML, print, or CSV (with founder and contact columns).

The report ends with the cost of the run: every API response carries the model tokens and search queries it used, priced at list rates in `cost.js`, and the page adds them up per step (search and discovery, first pass, second pass, founder lookup, executive summary). Re-running a step adds to the total; cached pages, screenshots and founder lookups cost nothing. These are estimates from token counts, not the invoice; the Anthropic and Serper dashboards remain the source of truth for billing. Set `SERPER_USD_PER_QUERY` in `.env` to your plan's per-query rate (0 on the free tier).

**Dashboard and saved runs.** The prototype has no accounts: Navojit is treated as already signed in (name and photo in the nav, from `reports.js`). Every run that reaches the ranked report is saved automatically under `data/reports/navojit/` as one JSON file holding the whole page state; the founder lookup and the executive summary update the same record. `dashboard.html` lists the runs with keyword, area, date, searches run, companies found, passed first pass, selected and estimated cost, plus totals across runs. Open sends you to `search.html?report=<id>` with every step restored; Delete removes the file. `data/` is git-ignored.

Every decision stays visible with its reasons, and `window.scout` in the browser console exposes the state and render functions for debugging.

## Running it

```
npm install
cp .env.example .env   # then fill in the keys
node server.js
```

Open http://localhost:8765/dashboard.html.

Keys in `.env`:

- `ANTHROPIC_API_KEY`: needed for the model judgements, the discovery agent and the report. Without it the first pass runs rules only and the search runs the seed query only.
- `SERPER_API_KEY`: Google results via serper.dev. The free tier returns 10 results per query, which is why the agent runs many narrow queries. Without it the server scrapes Brave Search, which ignores the date filter and rate-limits bursts.
- `CHROME_PATH`: optional, defaults to Google Chrome on macOS. Without Chrome the second pass runs without screenshots.

Fetched LinkedIn pages and screenshots are cached under `.cache/` for a week.

## Files

| File | Role |
|---|---|
| `server.js` | HTTP server: static pages plus `/api/search`, `/api/discover` (server-sent events), `/api/screen`, `/api/second`, `/api/founders`, `/api/report`, `/api/me`, `/api/reports` |
| `search.js` | Search providers (Serper, Brave fallback) and result normalisation |
| `discover.js` | Discovery agent: plans key terms, runs them, adapts with the SDK tool runner |
| `screen.js` | First pass: LinkedIn parsing, exclusion rules, model judgement |
| `second.js` | Second pass: website analysis, screenshots, model judgement, ranking score |
| `founders.js` | Founders and contact details: LinkedIn people search, website team/contact pages, model reconciliation |
| `report.js` | Executive summary for the report |
| `cost.js` | Cost meter: counts model tokens and search queries per request and prices them |
| `reports.js` | Saved reports for the signed-in user: list, load, save, delete under `data/reports/` |
| `assets/site.css` | Styles for the app pages (nav and buttons shared with the site's stylesheet) |

## Failures and resuming

The first pass, second pass and founder lookup stream one company at a time (server-sent events, like the discovery agent), and the page shows "34 of 100 screened · 1m 20s" as they arrive. A company that fails on its own (LinkedIn page unreadable, website down, model error) is marked unsure with the reason and the pass carries on. If the whole pass breaks (server restart, dropped connection, closed tab) the companies already finished are kept, the run is saved as interrupted, and the button becomes "Continue first pass (N left)", which sends only the remaining companies. Discovery keeps the companies found so far if a query fails, including the seed query.

Runs save from the first search onwards and after every step and every manual decision (overrides, reviews, second-pass decisions), so the dashboard shows "In progress · step 3 of 6" and Resume lands on that step. Cost is booked per company as results arrive, so an interrupted pass still carries its spend.

## Limits worth knowing

- LinkedIn pages are fetched two at a time with one retry; LinkedIn throttles bursts with HTTP 999.
- The first pass accepts up to 100 companies per run and the second pass up to 50.
- Founder names come from a Google/Brave search of LinkedIn profiles and from the company website, since LinkedIn's People tab needs a login. Personal emails are rare on the web; expect a LinkedIn profile for most founders and a generic company address for contact. Founder lookups are cached under `.cache/founders/` for a week.
- Model verdicts vary a little between runs on the same input. A labelled set of past decisions is the way to measure precision and recall before trusting any prompt change.
