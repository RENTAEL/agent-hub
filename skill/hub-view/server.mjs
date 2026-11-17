#!/usr/bin/env node
// Agent hub live view: a local web page showing hub task notes moving through open -> working -> answered -> done.
// Usage: node server.mjs   then open http://127.0.0.1:4317   (HUB_VIEW_PORT to change the port)
// It never writes to the vault; the only write is saving an edited sheet in HUB/files. Listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.HUB_VIEW_PORT || 4317);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.OBSIDIAN_VAULT || path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const TASKS = path.join(VAULT, 'agents', 'tasks');
const LOCK = path.join(os.tmpdir(), 'agent-hub-bridge.pid');
const OPENCODE = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
// Team files written by the bridge (see the team data contract). HUB_DIR points tests at a fake folder.
const HUB = process.env.HUB_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agent-hub');

function parse(text) {
  const t = text.replace(/\r\n/g, '\n');
  const fm = {};
  let body = t;
  if (t.startsWith('---\n')) {
    const end = t.indexOf('\n---', 4);
    if (end > 0) {
      for (const line of t.slice(4, end).split('\n')) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      body = t.slice(end + 4);
    }
  }
  // Split only on the three section names the hub writes: replies often hold "## " headings of their own.
  const b = '\n' + body;
  const at = (re) => { const m = [...b.matchAll(re)]; return m.length ? m : null; };
  const task = at(/\n## Task[ \t]*\n/g), reply = at(/\n## Reply[ \t]*\n/g), verdict = at(/\n## Claude verdict[ \t]*\n/g);
  const ti = task ? task[0].index : -1, ri = reply ? reply[0].index : -1, vi = verdict ? verdict[verdict.length - 1].index : -1;
  const cut = (start, len, ...ends) => { if (start < 0) return ''; const e = ends.filter((x) => x > start); return b.slice(start + len, e.length ? Math.min(...e) : b.length).trim(); };
  const sec = {
    task: task ? cut(ti, task[0][0].length, ri, vi) : '',
    reply: reply ? cut(ri, reply[0][0].length, vi) : '',
    'claude verdict': verdict ? cut(vi, verdict[verdict.length - 1][0].length) : '',
  };
  return { fm, sec };
}

function readNote(file) {
  try {
    const p = path.join(TASKS, file);
    const st = fs.statSync(p);
    const { fm, sec } = parse(fs.readFileSync(p, 'utf8'));
    if (fm.type !== 'agent-task') return null;
    const reply = sec.reply || '';
    const meta = (reply.match(/^\*From (\S+) \(([^)]*)\), ([^.]*)\./) || []);
    return {
      id: file, title: file.replace(/\.md$/, ''), to: fm.to || '?', from: fm.from || '?',
      model: meta[2] || fm.model || '', status: fm.status || 'open', group: fm.group || file.replace(/\.md$/, ''),
      round: Number(fm.round) || 1, kind: fm.kind || '', local: fm.local === 'true', created: fm.created || '',
      mtime: st.mtimeMs, sec, hasReply: !!reply, hasVerdict: !!sec['claude verdict'],
      failed: /\[!failure\]/.test(reply), taskPreview: (sec.task || '').split('\nFILE:')[0].slice(0, 220),
      verdictPreview: (sec['claude verdict'] || '').slice(0, 220),
    };
  } catch { return null; }
}

// Current notes, plus a running list of status changes seen since the server started.
let notes = new Map();
const events = [];
function scan() {
  let files = [];
  try { files = fs.readdirSync(TASKS).filter((f) => f.endsWith('.md')); } catch {}
  const next = new Map();
  for (const f of files) { const n = readNote(f); if (n) next.set(f, n); }
  let changed = next.size !== notes.size;
  for (const [id, n] of next) {
    const old = notes.get(id);
    if (!old || old.status !== n.status || old.mtime !== n.mtime) changed = true;
    if (notes.size && (!old || old.status !== n.status))
      events.unshift({ t: Date.now(), id, agent: n.to, group: n.group, round: n.round, from: old?.status || 'new', to: n.status });
  }
  events.length = Math.min(events.length, 150);
  notes = next;
  return changed;
}

function summary() {
  const list = [...notes.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 150).map(({ sec, ...n }) => n);
  return { list, events: events.slice(0, 60), health, now: Date.now() };
}

// Health: is each agent reachable right now?
let health = {};
const port = (p) => new Promise((r) => { const s = net.connect(p, '127.0.0.1'); s.setTimeout(1500); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); s.on('timeout', () => { s.destroy(); r(false); }); });
async function checkHealth() {
  const h = {};
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    h.ollama = { up: r.ok, detail: (await r.json()).models.map((m) => m.name).join(', ') };
  } catch { h.ollama = { up: false, detail: 'not reachable on :11434' }; }
  h.omniroute = (await port(20128)) ? { up: true, detail: 'gateway on :20128' } : { up: false, detail: 'not reachable on :20128' };
  h.opencode = fs.existsSync(OPENCODE) ? { up: true, detail: 'CLI installed, free models only' } : { up: false, detail: 'CLI not found' };
  let watcher = false;
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    watcher = Date.now() - fs.statSync(LOCK).mtimeMs < 90000 && (process.kill(pid, 0), true);
  } catch {}
  h.claude = { up: true, detail: watcher ? 'bridge watcher running' : 'watcher off: hub-ask runs the bridge itself' };
  const changed = JSON.stringify(h) !== JSON.stringify(health);
  health = h;
  return changed;
}

// Team: seats from team.json, joined with team-state.json and a short summary of each live file.
// Missing or half-written files read as empty, so the map just shows an empty team.
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) ?? d; } catch { return d; } };
const SAFE_ID = /^[\w.@+-]{1,200}$/;
const seatList = () => { const t = readJson(path.join(HUB, 'team.json'), {}); return (Array.isArray(t.seats) ? t.seats : []).filter((s) => s && typeof s.id === 'string' && SAFE_ID.test(s.id)); };
const liveCache = new Map(); // seatId -> { mtime, summary }: live files can be long, so parse only when they change
function liveSummary(id) {
  const p = path.join(HUB, 'live', id + '.json');
  let m; try { m = fs.statSync(p).mtimeMs; } catch { liveCache.delete(id); return null; }
  const c = liveCache.get(id); if (c && c.mtime === m) return c.summary;
  const j = readJson(p, null);
  if (!j || typeof j !== 'object') return c ? c.summary : null; // mid-write: keep the last good one
  const summary = { status: j.status || '', note: j.note || '', job: j.job || '', started: j.started || 0, updated: j.updated || 0, chars: String(j.text || '').length + String(j.thinking || '').length };
  liveCache.set(id, { mtime: m, summary });
  return summary;
}
function team() {
  const st = readJson(path.join(HUB, 'team-state.json'), {});
  const seats = seatList().map((s) => {
    const x = (st && typeof st[s.id] === 'object' && st[s.id]) || {};
    return { id: s.id, runner: s.runner || '', model: s.model || s.id, provider: s.provider || s.runner || 'other', local: !!s.local, ok: s.ok !== false, ms: s.ms || 0,
      downUntil: x.downUntil || 0, lastError: x.lastError || '', lastOk: x.lastOk || 0, wins: x.wins || 0, fails: x.fails || 0, live: liveSummary(s.id) };
  });
  const ag = readJson(path.join(HUB, 'claude-agents.json'), {});
  const claude = Object.entries(ag && typeof ag === 'object' ? ag : {}).filter(([, a]) => a && typeof a === 'object')
    .map(([id, a]) => ({ id, type: a.type || 'agent', started: a.started || 0, stopped: a.stopped || null, session: a.session || '' }))
    .sort((a, b) => b.started - a.started).slice(0, 40);
  return { seats, claude, now: Date.now() };
}

const clients = new Set();
const push = () => { const d = `data: ${JSON.stringify(summary())}\n\n`; for (const c of clients) c.write(d); };
let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(() => scan() && push(), 300); };
try { fs.watch(TASKS, soon); } catch {}
// OneDrive folders don't always fire watch events, so poll as well.
setInterval(() => scan() && push(), 3000);
setInterval(async () => (await checkHealth()) && push(), 10000);
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

// Sheets (optional, needs `npm install` + `npm run build` in ../sheets): agents' sheets as .xlsx, previewed in Univer.
// Files live in HUB/files only; the request names a path relative to it and sheet-core refuses anything outside.
const SHEETS = path.join(HERE, '..', 'sheets');
const SHEET_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";
let sheetCore;
async function sheets(req, res, url) {
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': SHEET_CSP, ...extra }); res.end(body); };
  if (!fs.existsSync(path.join(SHEETS, 'dist', 'view.js'))) return send(404, 'text/plain', 'Sheets are not set up: run "npm install" and "npm run build" in the sheets folder.');
  sheetCore ||= await import(new URL('../sheets/sheet-core.mjs', import.meta.url));
  const f = url.searchParams.get('f') || '';
  const p = url.pathname;
  if (p === '/sheets/view') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(SHEETS, 'view.html')));
  if (p === '/sheets/dist/view.js') return send(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(SHEETS, 'dist', 'view.js')));
  if (p === '/sheets/dist/view.css') return send(200, 'text/css; charset=utf-8', fs.readFileSync(path.join(SHEETS, 'dist', 'view.css')));
  if (p === '/sheets/list') return send(200, 'application/json', JSON.stringify(sheetCore.listSheets()));
  if (p === '/sheets/data') return send(200, 'application/json', fs.readFileSync(sheetCore.safePath(f, '.xlsx').replace(/\.xlsx$/i, '.univer.json')));
  if (p === '/sheets/download') {
    const x = sheetCore.safePath(f, '.xlsx');
    return send(200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fs.readFileSync(x), { 'Content-Disposition': `attachment; filename="${path.basename(x).replace(/"/g, '')}"` });
  }
  if (p === '/sheets/save' && req.method === 'POST') {
    // Only this page may save: another site open in the browser can't post here (Origin check + JSON content type).
    if (!new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}$`).test(req.headers.origin || '') || !/^application\/json/.test(req.headers['content-type'] || '')) return send(403, 'text/plain', 'forbidden');
    const x = sheetCore.safePath(f, '.xlsx');
    if (!fs.existsSync(x)) return send(404, 'text/plain', 'not found');
    let size = 0; const chunks = [];
    for await (const c of req) { if ((size += c.length) > 25e6) return send(413, 'text/plain', 'too large'); chunks.push(c); }
    const snap = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // Random temp names so two saves of one sheet can't collide; the snapshot is written first, the .xlsx swapped in last.
    const tmp = `${x}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      await sheetCore.snapshotToXlsx(snap, tmp);
      fs.writeFileSync(x.replace(/\.xlsx$/i, '.univer.json'), JSON.stringify(snap));
      fs.renameSync(tmp, x);
    } finally { fs.rmSync(tmp, { force: true }); }
    return send(200, 'text/plain', 'saved');
  }
  return send(404, 'text/plain', 'not found');
}

// The page may only load from this server and talk back to it; nothing in a note can call out elsewhere.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP }); res.end(body); };
  // DNS rebinding: a web page on another name that resolves to 127.0.0.1 could read the notes. Only local host names pass.
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) return send(403, 'text/plain', 'forbidden');
  if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(HERE, 'index.html')));
  if (url.pathname === '/api/state') return send(200, 'application/json', JSON.stringify(summary()));
  if (url.pathname === '/api/note') {
    // Only names already listed from the tasks folder: no path is ever built from the request.
    const n = notes.get(url.searchParams.get('id') || '');
    return n ? send(200, 'application/json', JSON.stringify({ ...n, task: n.sec.task || '', reply: n.sec.reply || '', verdict: n.sec['claude verdict'] || '' })) : send(404, 'text/plain', 'not found');
  }
  if (url.pathname === '/team') return send(200, 'application/json', JSON.stringify(team()));
  if (url.pathname.startsWith('/sheets/')) return sheets(req, res, url).catch((e) => { if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(String(e.message || e)); } });
  if (url.pathname === '/live') {
    // The id must be a seat listed in team.json (and filesystem-safe), so no path comes from the request alone.
    const id = url.searchParams.get('seat') || '';
    if (!SAFE_ID.test(id) || !seatList().some((s) => s.id === id)) return send(404, 'text/plain', 'not found');
    const file = path.join(HUB, 'live', id + '.json');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let last = -1, beats = 0;
    const tick = () => {
      let m = 0; try { m = fs.statSync(file).mtimeMs; } catch {}
      if (m && m !== last) { const j = readJson(file, null); if (j && typeof j === 'object') { last = m; res.write(`data: ${JSON.stringify(j)}\n\n`); } }
      if (++beats % 40 === 0) res.write(': ping\n\n');
    };
    tick();
    const iv = setInterval(tick, 500);
    const stop = () => clearInterval(iv);
    req.on('close', stop); res.on('error', stop);
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(summary())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    res.on('error', () => clients.delete(res));
    return;
  }
  send(404, 'text/plain', 'not found');
});

scan();
await checkHealth();
server.listen(PORT, '127.0.0.1', () => console.log(`agent hub view: http://127.0.0.1:${PORT}  (watching ${TASKS})`));
