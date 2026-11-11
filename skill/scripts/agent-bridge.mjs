#!/usr/bin/env node
// Agent hub bridge: hands open task notes in the vault's agents/tasks/ folder to OmniRoute, Ollama or OpenCode
// and writes each reply back into the same note. Claude writes the tasks and reviews the replies; this script only relays.
// Usage: node agent-bridge.mjs            process open tasks once
//        node agent-bridge.mjs --watch    keep polling every 5 s, several tasks per agent at once
//        node agent-bridge.mjs --selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gatewayKey, loadTeam, loadState, markSeat, liveWriter, seatId } from './team.mjs';
import { pickSeats } from './pick-seats.mjs';

const VAULT = process.env.OBSIDIAN_VAULT || path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const TASKS = path.join(VAULT, 'agents', 'tasks');
const TIMEOUT_MS = 10 * 60 * 1000;
// OmniRoute and OpenCode send prompts to cloud models: refuse text holding something shaped like a real credential.
// Matches key formats and quoted secret values, not the bare words "token" or "password" that appear in normal code.
export const SECRET = new RegExp([
  String.raw`(api[_-]?key|secret|passw(or)?d|pwd|token|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{6,}["']`,
  String.raw`(pwd|password)=[^;&\s]{4,}`, // connection strings
  String.raw`authorization:\s*\S+\s+\S{12,}`, String.raw`bearer\s+[\w.-]{20,}`,
  // Unquoted values: must hold a digit, so code like `password = getPassword()` is not flagged.
  String.raw`\b(api[_-]?key|secret|passw(or)?d|client[_-]?secret|access[_-]?key)\s*[:=]\s*(?=[^\s"'<>{}$;,().]*\d)[^\s"'<>{}$;,().]{6,}`,
  String.raw`(AccountKey|SharedAccessKey)=[^;\s]{8,}`, String.raw`\w+://[^\s:/@]+:[^\s@/]{3,}@`, // Azure, URL credentials
  String.raw`\bsk-[\w-]{16,}`, String.raw`\b[sr]k_(live|test)_\w{10,}`, String.raw`AIza[\w-]{35}`, String.raw`\b1000\.[0-9a-f]{32}\.[0-9a-f]{32}`,
  String.raw`AKIA[0-9A-Z]{16}`, String.raw`gh[pousr]_\w{20,}`, 'github_pat_', String.raw`xox[abpr]-\w`,
  String.raw`eyJ[\w-]{10,}\.eyJ[\w-]{10,}`, '-----BEGIN [A-Z ]*PRIVATE KEY', String.raw`MII[A-Za-z0-9+/]{60,}`,
].join('|'), 'i');
// Tokens that are public by design (sent to every visitor's browser) are removed before the check.
const PUBLIC = /data-cf-beacon=('[^']*'|"[^"]*")/gi;
export const hasSecret = (s) => SECRET.test(String(s).replace(PUBLIC, ''));
export const CLOUD = new Set(['omniroute', 'opencode']);
// Run the real exe, never through cmd.exe, so a task string is never parsed as a command line.
const OPENCODE = process.env.OPENCODE_EXE || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');

const LOCK = path.join(os.tmpdir(), 'agent-hub-bridge.pid');
// Alive only if the PID runs AND the watcher touched the lock recently: a reused PID or a crash leaves it stale.
export function watcherAlive() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    if (!(pid > 0) || Date.now() - fs.statSync(LOCK).mtimeMs > 90000) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

export function parse(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  const body = text.slice(m[0].length);
  // shortcut: a "## " line inside a code fence ends the task early; use ### inside tasks if that ever matters.
  const task = (body.match(/^## Task[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m) || [])[1]?.trim() || '';
  return { fm, body, task };
}

export function setField(text, key, value) {
  // Only touch the frontmatter block, never a matching line in the body.
  const m = text.match(/^---\r?\n([\s\S]*?)(\r?\n---)/);
  if (!m) return text;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const line = `${key}: ${String(value).replace(/[\r\n]+/g, ' ')}`; // one line, so a value can never add keys
  const fm = re.test(m[1]) ? m[1].replace(re, () => line) : `${m[1]}\n${line}`;
  return `---\n${fm}${m[2]}` + text.slice(m[0].length);
}

// The key is read once per bridge run (one hidden PowerShell call), not once per task.
let KEY;
const key = () => (KEY ??= gatewayKey());

// Read a streamed response line by line; onLine gets each non-empty line.
async function streamLines(res, onLine) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
  }
  if (buf.trim()) onLine(buf.trim());
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`${res.status} ${j.error?.message || j.error || ''}`.slice(0, 300)); }
  return res;
}

const quiet = { think() {}, write() {} };
const errText = (e) => String(e?.message ?? (typeof e === 'object' ? JSON.stringify(e) : e)).slice(0, 300);
// Each runner streams: thinking text to live.think, answer text to live.write, and returns the full answer.
const agents = {
  async omniroute(task, model, live = quiet) {
    const k = key();
    const res = await post('http://localhost:20128/v1/chat/completions', { model: model || 'free', stream: true, messages: [{ role: 'user', content: task }] }, k ? { authorization: `Bearer ${k}` } : {});
    let text = '', used = model || 'free', sse = false, finished = false, plain = '';
    await streamLines(res, (line) => {
      if (!line.startsWith('data:')) { plain += line + '\n'; return; }
      sse = true;
      if (line === 'data: [DONE]') { finished = true; return; }
      let j; try { j = JSON.parse(line.slice(5)); } catch { return; }
      if (j.error) throw new Error(errText(j.error));
      used = j.model || used;
      const c = j.choices?.[0] || {}, d = c.delta || {};
      if (c.finish_reason) finished = true;
      const think = d.reasoning_content || d.reasoning;
      if (think) live.think(think);
      if (d.content) { text += d.content; live.write(d.content); }
    });
    // A gateway that ignored stream:true sends one plain JSON body instead.
    if (!sse) {
      let j; try { j = JSON.parse(plain); } catch { throw new Error(`not a stream or JSON reply: ${plain.slice(0, 120)}`); }
      if (j.error) throw new Error(errText(j.error));
      const m = j.choices?.[0]?.message || {};
      if (m.reasoning_content || m.reasoning) live.think(m.reasoning_content || m.reasoning);
      if (m.content) live.write(m.content);
      return { text: m.content || '', model: j.model || used };
    }
    // A stream cut off before its end marker is a partial answer, not a success.
    if (!finished) throw new Error(`stream ended early after ${text.length} chars`);
    return { text, model: used };
  },
  async ollama(task, model, live = quiet) {
    if (!model) {
      const tags = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
      model = process.env.OLLAMA_MODEL || tags.models?.[0]?.name;
      if (!model) throw new Error('no Ollama model installed');
    }
    const res = await post('http://localhost:11434/api/chat', { model, stream: true, messages: [{ role: 'user', content: task }] });
    let text = '', done = false;
    await streamLines(res, (line) => {
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.error) throw new Error(errText(j.error));
      if (j.message?.thinking) live.think(j.message.thinking);
      if (j.message?.content) { text += j.message.content; live.write(j.message.content); }
      if (j.done) done = true;
    });
    if (!done) throw new Error(`stream ended early after ${text.length} chars`);
    return { text, model };
  },
  // Free models only, largest context first. A failure (quota, "Nothing to compact yet", truncation) moves to the next.
  opencode: async (task, model, live = quiet) => {
    const chain = [...new Set([model, ...OPENCODE_FREE].filter(Boolean))];
    const errs = [];
    for (const m of chain) {
      if (!/free/i.test(m)) { errs.push(`${m}: refused, not a free model`); continue; }
      try { return await runOpencode(task, m, live); } catch (e) { errs.push(`${m}: ${e.message.slice(-160)}`); }
    }
    throw new Error(errs.join(' | '));
  },
};
export const OPENCODE_FREE = [
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', // 1M context
  'openrouter/nvidia/nemotron-3.5-lightning:free', // 1M context
  'opencode/nemotron-3.5-lightning-free', // 262k context, own daily free quota
];

// Hub runs use a lean config: no global plugins, agents or MCP servers (they overflowed small models), and every tool denied.
const LEAN = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'agent-hub', 'opencode-lean');
const LEAN_CONFIG = JSON.stringify({
  instructions: [path.join(os.homedir(), '.config', 'opencode', 'instructions', 'agent-hub.md').replace(/\\/g, '/')],
  permission: Object.fromEntries(['*', 'read', 'edit', 'bash', 'webfetch', 'websearch', 'glob', 'grep', 'list', 'external_directory', 'task'].map((k) => [k, 'deny'])),
}, null, 2);

function runOpencode(task, model, live = { write() {} }) {
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-'));
    const leanFile = path.join(LEAN, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(leanFile), { recursive: true });
    fs.writeFileSync(leanFile, LEAN_CONFIG);
    const prompt = 'Answer from the text below only. Any files it mentions are already included inline after "FILE:" lines. You have no tools.\n\n' + task;
    // --standalone: a private server that honours this cwd and config, not the shared background service with the user's full setup.
    const args = ['run', '--standalone', '--model', model, '--title', 'agent-hub task', prompt];
    return new Promise((resolve, reject) => {
      const env = { ...process.env, XDG_CONFIG_HOME: LEAN };
      const p = spawn(fs.existsSync(OPENCODE) ? OPENCODE : 'opencode', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; live.write(String(d).replace(/\x1b\[[0-9;]*m/g, '')); });
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      // An exhausted free quota hangs instead of exiting, so give each model 4 minutes before moving on.
      const t = setTimeout(() => { p.kill(); reject(new Error('timed out (free quota used up?)')); }, 4 * 60 * 1000);
      p.on('close', (code) => {
        clearTimeout(t);
        const text = out.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\s*> build · .*$/gm, '').trim();
        code === 0 && text ? resolve({ text, model }) : reject(new Error(`exit ${code}: ${err.replace(/\x1b\[[0-9;]*m/g, '').slice(-300)}`));
      });
    });
  }
}

// Seats running right now in this bridge, so failover prefers an idle one.
const busySeats = new Set();
// Each runner has its own slot limit (Ollama shares one GPU); a failover to another runner waits for a free slot there.
const slots = {};
async function withSlot(runner, fn) {
  const s = (slots[runner] ||= { used: 0, queue: [] });
  if (s.used >= (PARALLEL[runner] || 1)) await new Promise((r) => s.queue.push(r));
  else s.used++;
  try { return await fn(); } finally { const next = s.queue.shift(); if (next) next(); else s.used--; }
}

const MAX_SEATS = 3; // a task tries at most this many seats before it fails
async function handle(file) {
  let text = fs.readFileSync(file, 'utf8');
  const note = parse(text);
  // A note stuck on "working" (the bridge was killed) is retried once it is older than the timeout.
  const stale = note?.fm.status === 'working' && Date.now() - fs.statSync(file).mtimeMs > TIMEOUT_MS + 60000;
  if (!note || note.fm.type !== 'agent-task' || !(note.fm.status === 'open' || stale) || note.fm.to === 'claude') return false;
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (!agents[note.fm.to] || !note.task) {
    fs.writeFileSync(file, setField(text, 'status', 'failed').trimEnd() + `\n\n## Reply\n> [!failure] ${!agents[note.fm.to] ? `unknown agent "${note.fm.to}"` : 'no "## Task" section'}\n`);
    return true;
  }
  const secret = hasSecret(note.task), local = note.fm.local === 'true';
  if (CLOUD.has(note.fm.to) && (secret || local)) {
    const why = local ? 'the task came from a local-only folder' : 'the task holds something shaped like a credential';
    fs.writeFileSync(file, setField(text, 'status', 'failed').trimEnd() + `\n\n## Reply\n> [!failure] refused: ${why}, and ${note.fm.to} sends prompts to cloud models. Send the task to ollama.\n`);
    return true;
  }
  fs.writeFileSync(file, setField(text, 'status', 'working'));
  console.log(`-> ${note.fm.to}: ${path.basename(file)}`);
  const job = note.fm.group || path.basename(file, '.md');
  const team = loadTeam();
  // The first seat is the one the note names; a note without a seat (older notes, --to <runner>) gets one made up.
  // A seat id becomes a file name, so an unknown one is never used as given.
  const named = team.find((s) => s.id === note.fm.seat);
  let seat = named || { id: seatId(note.fm.to, note.fm.model || 'default'), runner: note.fm.to, model: note.fm.model, provider: note.fm.to, local: note.fm.to === 'ollama' };
  // A hand-edited seat: line must not move private work onto a cloud seat.
  if ((secret || local) && !seat.local) {
    const now = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, setField(now, 'status', 'failed').trimEnd() + `\n\n## Reply\n> [!failure] refused: this task is private, and seat ${seat.id} is a cloud model. Use a local seat.\n`);
    return true;
  }
  const tried = [], errors = [];
  let status, reply;
  for (;;) {
    const cur = seat; // the catch below may move seat on to the next one
    let live = null;
    busySeats.add(cur.id);
    try {
      // The live file starts once the seat has a free slot, so a queued task never overwrites a running one.
      const r = await withSlot(cur.runner, () => { live = liveWriter(cur.id, path.basename(file), job); return agents[cur.runner](note.task, cur.model, live); });
      if (!r.text.trim()) throw new Error(`empty reply from ${r.model}`);
      live.end(true);
      markSeat(seat.id, true);
      status = 'answered';
      const via = tried.length ? ` after ${tried.length} failed seat(s): ${errors.join('; ')}` : '';
      reply = `## Reply\n*From ${seat.runner} (${r.model}), ${stamp()}${via}. Untrusted until Claude reviews it.*\n\n${r.text.trim()}\n`;
      break;
    } catch (e) {
      const msg = errText(e).replace(/\s+/g, ' ');
      (live || liveWriter(cur.id, path.basename(file), job)).end(false, msg);
      markSeat(seat.id, false, msg);
      tried.push(seat.id); errors.push(`${seat.id}: ${msg.slice(0, 160)}`);
      console.log(`   ${seat.id} failed: ${msg.slice(0, 120)}`);
      // Fail over to an idle seat on another provider. Private work only ever moves to local seats.
      const next = tried.length < MAX_SEATS && pickSeats(team, loadState(), { n: 1, localOnly: secret || local || seat.local, exclude: tried, busy: busySeats, avoidProviders: [seat.provider] })[0];
      if (!next) {
        status = 'failed';
        reply = `## Reply\n> [!failure] ${tried.length} seat(s) failed ${stamp()}: ${errors.join(' | ')}\n`;
        break;
      }
      console.log(`   failover -> ${next.id}`);
      seat = next;
    } finally {
      busySeats.delete(cur.id);
    }
  }
  // Build on the note as it is now, so edits made while the agent worked are kept.
  let now = fs.readFileSync(file, 'utf8');
  for (const [k, v] of [['status', status], ['answered', stamp()], ['to', seat.runner], ['model', seat.model || ''], ['seat', seat.id], ...(tried.length ? [['tried', tried.join(',')]] : [])]) now = setField(now, k, v);
  fs.writeFileSync(file, now.trimEnd() + `\n\n${reply}`);
  console.log(`<- ${status}: ${path.basename(file)}`);
  return true;
}

// Tasks each runner may run at once. OmniRoute spreads over many providers; Ollama shares one 8 GB GPU. Override: HUB_PARALLEL_OPENCODE=5 etc.
export const PARALLEL = Object.fromEntries(Object.entries({ opencode: 3, omniroute: 8, ollama: 2 })
  .map(([k, v]) => [k, Math.max(1, Number(process.env[`HUB_PARALLEL_${k.toUpperCase()}`]) || v)]));
const inflight = new Map(); // note path -> promise
const running = {}; // agent -> tasks in flight
let done = 0;

// Start every waiting task that fits in its agent's free slots; returns how many started.
function pump() {
  if (!fs.existsSync(TASKS)) throw new Error(`no task folder: ${TASKS}`);
  let started = 0;
  const files = fs.readdirSync(TASKS).filter((f) => f.endsWith('.md')).map((f) => path.join(TASKS, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs); // oldest first
  for (const f of files) {
    if (inflight.has(f)) continue;
    let fm;
    try { fm = parse(fs.readFileSync(f, 'utf8'))?.fm; } catch { continue; } // file mid-sync: next pass
    // Same filter as handle(): a fresh 'working' note belongs to another run, so skip it (else runOnce spins).
    const stale = fm?.status === 'working' && Date.now() - fs.statSync(f).mtimeMs > TIMEOUT_MS + 60000;
    if (!fm || fm.type !== 'agent-task' || !(fm.status === 'open' || stale) || fm.to === 'claude') continue;
    const to = fm.to;
    if ((running[to] || 0) >= (PARALLEL[to] || 1)) continue;
    running[to] = (running[to] || 0) + 1;
    started++;
    const p = handle(f)
      .then((did) => { if (did) done++; })
      .catch((e) => console.error(`${path.basename(f)}: ${e.message}`))
      .finally(() => { inflight.delete(f); running[to]--; });
    inflight.set(f, p);
  }
  return started;
}

// One-shot: keep filling free slots until nothing is waiting or running.
async function runOnce() {
  done = 0;
  pump();
  while (inflight.size) { await Promise.race(inflight.values()); pump(); }
  return done;
}

// Run only when started directly, so hub-ask.mjs can import SECRET and CLOUD.
const MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!MAIN) {
  // imported as a module
} else if (process.argv.includes('--selftest')) {
  const t = '---\ntype: agent-task\nto: ollama\nstatus: open\n---\n\n## Task\nSay hi.\n\nMore.\n\n## Notes\nx\n';
  const n = parse(t);
  console.assert(n.fm.to === 'ollama' && n.fm.status === 'open', 'frontmatter');
  console.assert(n.task === 'Say hi.\n\nMore.', `task section: ${JSON.stringify(n.task)}`);
  console.assert(parse('---\nto: x\n---\n## Task\nlast\n').task === 'last', 'task at end');
  console.assert(parse('---\nto: x\r\n---\r\n## Task\r\ncrlf\r\n').task === 'crlf', 'crlf');
  console.assert(parse(setField(t, 'status', 'done')).fm.status === 'done', 'setField existing');
  console.assert(parse(setField(t, 'answered', '1')).fm.answered === '1', 'setField new');
  console.assert(parse(setField('---\nto: x\n---\nstatus: open\n', 'status', 'done')).body === 'status: open\n', 'setField leaves body alone');
  for (const s of ['api_key = "abcd1234efgh"', "PASSWORD: 'hunter2hunter'", 'Server=x;Pwd=S3cret!;', 'sk-ant-api03-abcdefghijklmnop', 'Authorization: Bearer abcdefghijklmnopqrstuv', 'AKIAABCDEFGHIJKLMNOP',
    'password: abc123', 'API_KEY=abc123xyz', 'AccountKey=abcdEFGH1234==;', 'sk_live_abcdefghij12', 'AIza' + 'a'.repeat(35),
    '1000.' + 'a'.repeat(32) + '.' + 'b'.repeat(32), 'postgres://u:pw1@host/db', 'MII' + 'A'.repeat(64)])
    console.assert(hasSecret(s), `secret not caught: ${s}`);
  for (const s of ['summarise the ticket flow', 'const token = req.headers.token;', 'if (!password) throw new Error("password required")', 'refreshToken(user)',
    'risk-assessment-overview-panel', 'desk-layout-container-wide', 'https://example.com/a', 'const password = getPassword();', 'password: process.env.DB_PASS',
    `data-cf-beacon='{"version":"2024.11.0","token":"bc7b6bf00fe54ae2aa74f8890ee56059","r":1}'`])
    console.assert(!hasSecret(s), `false alarm: ${s}`);
  console.log('selftest done (no assertion output above = pass)');
} else if (watcherAlive()) {
  // One bridge at a time: two would both pick up the same open note.
  console.log('a watcher is already running; it will handle open tasks');
} else if (process.argv.includes('--watch')) {
  fs.writeFileSync(LOCK, String(process.pid));
  console.log(`watching ${TASKS} (parallel: ${Object.entries(PARALLEL).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  // Heartbeat on its own timer, so a long task never makes the watcher look dead.
  setInterval(() => fs.writeFileSync(LOCK, String(process.pid)), 15000);
  for (;;) {
    try { pump(); } catch (e) { console.error(e.message); }
    await new Promise((r) => setTimeout(r, 5000));
  }
} else {
  console.log(`processed ${await runOnce()} task(s)`);
}
