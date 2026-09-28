// Saved reports for the signed-in user.
//
// The prototype has no accounts: Navojit is treated as already signed in, and
// every run that reaches the ranked report is saved under his user id as one
// JSON file in data/reports/<user>/<id>.json. The file holds the whole page
// state, so a saved report reopens with every step intact.

const fs = require('fs');
const path = require('path');

const USER = {
  id: 'navojit',
  name: 'Navojit Dastidar',
  role: 'Founder, Scout Engine',
  photo: 'assets/founder.jpeg',
  linkedin: 'https://www.linkedin.com/in/navojit-dastidar',
};

const ROOT = path.join(__dirname, 'data', 'reports');
const ID_RE = /^[a-z0-9]{6,40}$/;

function dir(user) { return path.join(ROOT, user.id); }
function file(user, id) { return path.join(dir(user), id + '.json'); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }

// Summary shown in the list; the full state stays on disk until opened.
function meta(rec) {
  return { id: rec.id, title: rec.title, query: rec.query, sector: rec.sector, location: rec.location, created_at: rec.created_at, updated_at: rec.updated_at, searches: rec.searches, gathered: rec.gathered, screened: rec.screened, passed_first: rec.passed_first, identified: rec.identified, cost_usd: rec.cost_usd, has_summary: rec.has_summary, reached: rec.reached, in_progress: rec.in_progress };
}

function list(user) {
  let names = [];
  try { names = fs.readdirSync(dir(user)).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(meta(JSON.parse(fs.readFileSync(path.join(dir(user), n), 'utf8')))); } catch (_) { /* skip a bad file */ }
  }
  return out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
}

function load(user, id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(file(user, id), 'utf8')); } catch (_) { return null; }
}

// Creates a report, or updates one when body.id names an existing file.
function save(user, body) {
  const now = new Date().toISOString();
  let rec = body.id && validId(body.id) ? load(user, body.id) : null;
  if (!rec) rec = { id: newId(), created_at: now };
  rec.updated_at = now;
  rec.title = String(body.title || rec.title || 'Scouting report').slice(0, 200);
  rec.query = String(body.query || '').slice(0, 500);
  rec.sector = String(body.sector || '').slice(0, 120);
  rec.location = String(body.location || '').slice(0, 120);
  rec.searches = Number(body.searches) || 0;
  rec.screened = Number(body.screened) || 0;
  rec.passed_first = Number(body.passed_first) || 0;
  rec.gathered = Number(body.gathered) || 0;
  rec.identified = Number(body.identified) || 0;
  rec.cost_usd = Number(body.cost_usd) || 0;
  rec.has_summary = !!body.has_summary;
  rec.reached = Math.min(6, Math.max(1, Number(body.reached) || 1));
  rec.in_progress = !!body.in_progress;
  rec.state = body.state && typeof body.state === 'object' ? body.state : {};
  fs.mkdirSync(dir(user), { recursive: true });
  fs.writeFileSync(file(user, rec.id), JSON.stringify(rec));
  return meta(rec);
}

function remove(user, id) {
  if (!validId(id)) return false;
  try { fs.unlinkSync(file(user, id)); return true; } catch (_) { return false; }
}

module.exports = { USER, list, load, save, remove, validId };
