// Scout Engine local server.
//
// Serves the static site and the pipeline API used by search.html:
//   POST /api/search    one LinkedIn-scoped query            (search.js)
//   POST /api/discover  discovery agent, streams its trace   (discover.js)
//   POST /api/screen    first pass, streams one company at a time (screen.js)
//   POST /api/second    second pass on the website, streamed  (second.js)
//   POST /api/founders  founders and contact details, streamed (founders.js)
//   POST /api/report    executive summary for the report      (report.js)
//   GET  /api/me        the signed-in user (fixed; no accounts) (reports.js)
//   GET/POST /api/reports, GET/DELETE /api/reports/:id  saved reports
// Every response carries `usage`: model tokens and search queries for that
// call, priced by cost.js so the page can total the cost of a run.
//
// Keys live in .env next to this script: SERPER_API_KEY (optional, Google
// results), ANTHROPIC_API_KEY (model judgement and agents).

const http = require('http');
const fs = require('fs');
const path = require('path');
loadDotEnv(); // before the modules below read their keys
const { execFile } = require('child_process');
const { search, provider } = require('./search');
const { discover } = require('./discover');
const { screen, safeName } = require('./screen');
const { secondPass, SHOT_DIR } = require('./second');
const { foundersPass } = require('./founders');
const { report } = require('./report');
const reports = require('./reports');

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Local tool: same-origin requests from the browser only. Posts must be JSON;
// deletes carry no body.
function allowedPost(req) {
  const host = String(req.headers.host || '');
  const origin = req.headers.origin;
  const okHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const okOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const okType = req.method === 'DELETE' || /^application\/json/i.test(String(req.headers['content-type'] || ''));
  return okHost && okOrigin && okType;
}

http.createServer(async (req, res) => {
  try {
    if ((req.method === 'POST' || req.method === 'DELETE') && !allowedPost(req)) return json(res, 403, { error: 'Only same-origin JSON requests are accepted' });
    if (req.method === 'GET' && req.url === '/api/me') return json(res, 200, { user: reports.USER });
    if (req.url === '/api/reports' || req.url.startsWith('/api/reports/')) return await handleReports(req, res);
    if (req.method === 'POST' && req.url === '/api/search') return await handleSearch(req, res);
    if (req.method === 'POST' && req.url === '/api/discover') return await handleDiscover(req, res);
    if (req.method === 'POST' && req.url === '/api/screen') return await handleScreen(req, res);
    if (req.method === 'POST' && req.url === '/api/second') return await handleSecond(req, res);
    if (req.method === 'POST' && req.url === '/api/founders') return await handleFounders(req, res);
    if (req.method === 'POST' && req.url === '/api/report') return await handleReport(req, res);
    if (req.method === 'GET' && req.url.startsWith('/shots/')) return serveShot(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Server error: ' + err.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  pruneCache();
  console.log(`Scout Engine  http://localhost:${PORT}/dashboard.html`);
  console.log(`Search provider: ${provider() === 'serper' ? 'serper (Google, 10 per query on the free tier)' : 'brave (no SERPER_API_KEY set)'}`);
  const creds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  console.log(`Model judgement: ${creds ? 'on (claude-opus-5)' : 'off (no ANTHROPIC_API_KEY; rules only)'}`);
  console.log(`Website screenshots: ${fs.existsSync(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? 'on (headless Chrome)' : 'off (set CHROME_PATH)'}`);
});

// ---------------------------------------------------------------- search API

async function handleSearch(req, res) {
  const body = await readJson(req);
  const query = String(body.query || '').trim();
  if (!query) return json(res, 400, { error: 'Missing query' });
  json(res, 200, await search(query));
}

// Discovery agent: widens the search and streams its trace as server-sent events.
async function handleDiscover(req, res) {
  const body = await readJson(req);
  const query = String(body.query || '').trim();
  if (!query) return json(res, 400, { error: 'Missing query' });
  const { send, end } = sse(res);
  try {
    await discover({ query, sector: body.sector, location: body.location, country: body.country, since: body.since, budget: Math.min(30, Math.max(1, Number(body.budget) || 0)) || undefined, sizeClause: String(body.sizeClause || ''), brief: body.brief && typeof body.brief === 'object' ? body.brief : {} }, send);
  } catch (e) {
    send({ type: 'error', error: e.message });
  } finally {
    end();
  }
}

// Company records come from the browser; slugs become cache filenames, so they are checked here.
const SLUG_RE = /^[a-z0-9][a-z0-9._%&-]{0,119}$/i;
function validCompanies(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c.slug === 'string' && SLUG_RE.test(c.slug) && !c.slug.includes('..') && typeof c.name === 'string' && c.name.trim());
}

// The three long passes stream one event per company as it finishes, then a
// `done` event with the summary and usage. A dropped connection or a crash
// therefore loses nothing already sent: the page keeps the finished companies
// and sends only the rest next time.
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (ev) => { try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (_) { /* client gone */ } };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 10000);
  return { send, end: () => { clearInterval(ping); res.end(); } };
}

async function streamPass(res, run) {
  const { send, end } = sse(res);
  try {
    const data = await run((item, index, usage) => send({ type: 'company', index, company: item, usage }));
    send({ type: 'done', summary: data.summary, model: data.model, screenshots: data.screenshots, usage: data.usage });
  } catch (e) {
    send({ type: 'error', error: e.message });
  } finally {
    end();
  }
}

// First pass: enrich from LinkedIn, apply exclusion rules, optional model judgement.
async function handleScreen(req, res) {
  const body = await readJson(req);
  const companies = validCompanies(body.companies);
  if (!companies.length) return json(res, 400, { error: 'No companies to screen' });
  if (companies.length > 100) return json(res, 400, { error: 'Screen at most 100 companies at a time' });
  await streamPass(res, (emit) => screen(companies, { brief: body.brief || null, emit }));
}

// Second pass: website, founders, design, pages and calls to action.
async function handleSecond(req, res) {
  const body = await readJson(req);
  const companies = validCompanies(body.companies);
  if (!companies.length) return json(res, 400, { error: 'No companies for the second pass' });
  if (companies.length > 50) return json(res, 400, { error: 'Second pass handles at most 50 companies at a time' });
  await streamPass(res, (emit) => secondPass(companies, { brief: body.brief || null, emit: (c, i, usage) => {
    if (c.second.screenshot) c.second.screenshot = '/shots/' + safeName(c.slug) + '.png';
    emit(c, i, usage);
  } }));
}

// Founders: names, LinkedIn profiles and contact details for the final list.
async function handleFounders(req, res) {
  const body = await readJson(req);
  const companies = validCompanies(body.companies);
  if (!companies.length) return json(res, 400, { error: 'No companies for the founder lookup' });
  if (companies.length > 50) return json(res, 400, { error: 'Founder lookup handles at most 50 companies at a time' });
  await streamPass(res, (emit) => foundersPass(companies, { emit }));
}

// Report: executive summary over the ranked final list.
async function handleReport(req, res) {
  const body = await readJson(req);
  if (!Array.isArray(body.companies)) return json(res, 400, { error: 'No companies for the report' });
  const funnel = Object.assign({ gathered: 0, firstEliminated: 0, secondEliminated: 0, unsure: 0 }, body.funnel && typeof body.funnel === 'object' ? body.funnel : {});
  json(res, 200, await report({ ...body, funnel }));
}

// Saved reports: list, open, save (create or update), delete. One fixed user.
async function handleReports(req, res) {
  const user = reports.USER;
  const id = req.url.startsWith('/api/reports/') ? decodeURIComponent(req.url.slice('/api/reports/'.length).split('?')[0]) : '';
  if (req.method === 'GET' && !id) return json(res, 200, { user, reports: reports.list(user) });
  if (req.method === 'GET') {
    const rec = reports.load(user, id);
    return rec ? json(res, 200, rec) : json(res, 404, { error: 'No such report' });
  }
  if (req.method === 'POST' && !id) {
    const body = await readJson(req, 25e6); // a full run with 100 companies is a few hundred KB
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'Nothing to save' });
    return json(res, 200, { saved: reports.save(user, body), reports: reports.list(user) });
  }
  if (req.method === 'DELETE' && id) {
    return reports.remove(user, id) ? json(res, 200, { deleted: id, reports: reports.list(user) }) : json(res, 404, { error: 'No such report' });
  }
  res.writeHead(405).end();
}

function serveShot(req, res) {
  const name = safeName(decodeURIComponent(req.url.split('?')[0].slice('/shots/'.length)).replace(/\.png$/i, '')) + '.png';
  fs.readFile(path.join(SHOT_DIR, name), (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ------------------------------------------------------------------ helpers

function readJson(req, max = 2e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > max) { req.destroy(); reject(new Error('Request body too large')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Only the two pages and the assets folder are public. Server modules, node_modules,
// dotfiles and the cache are never served.
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/dashboard.html';
  const allowed = p === '/search.html' || p === '/dashboard.html' || (p.startsWith('/assets/') && !p.includes('..'));
  const file = path.normalize(path.join(ROOT, p));
  if (!allowed || !file.startsWith(ROOT + path.sep) || path.basename(file).startsWith('.')) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    // The pages change often during prototyping; never let the browser cache them.
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// Drop cached LinkedIn pages and screenshots older than a week so .cache does not grow forever.
function pruneCache() {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  for (const dir of [path.join(ROOT, '.cache', 'linkedin'), path.join(ROOT, '.cache', 'founders'), SHOT_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      const f = path.join(dir, n);
      try { if (Date.now() - fs.statSync(f).mtimeMs > maxAge) fs.unlinkSync(f); } catch (_) { /* ignore */ }
    }
  }
}

function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* no .env */ }
}
