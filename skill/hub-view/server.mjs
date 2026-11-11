#!/usr/bin/env node
// Agent hub live view: a local web page showing hub task notes moving through open -> working -> answered -> done.
// Usage: node server.mjs   then open http://127.0.0.1:4317   (HUB_VIEW_PORT to change the port)
// Read-only: it never writes to the vault. Listens on 127.0.0.1 only.
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

const clients = new Set();
const push = () => { const d = `data: ${JSON.stringify(summary())}\n\n`; for (const c of clients) c.write(d); };
let timer;
const soon = () => { clearTimeout(timer); timer = setTimeout(() => scan() && push(), 300); };
try { fs.watch(TASKS, soon); } catch {}
// OneDrive folders don't always fire watch events, so poll as well.
setInterval(() => scan() && push(), 3000);
setInterval(async () => (await checkHealth()) && push(), 10000);
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

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
