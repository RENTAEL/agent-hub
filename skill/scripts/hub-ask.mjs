#!/usr/bin/env node
// Fan one brief out to several hub agents as task notes, wait for every reply, print them for Claude to review.
// Usage: node hub-ask.mjs --name "slugify helper" --kind code|research [--to opencode,ollama,omniroute]
//                         [--round 2] [--model omniroute=auto/coding:free] (--file brief.md | "brief text")
// A fix round is the same call with --round N, --to <agents that must fix>, and a brief holding Claude's review.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasSecret, CLOUD, OPENCODE_FREE } from './agent-bridge.mjs';

const VAULT = process.env.OBSIDIAN_VAULT || path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const TASKS = path.join(VAULT, 'agents', 'tasks');
const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-bridge.mjs');
// Free defaults per kind. OpenCode: the largest-context free model; the bridge falls back down OPENCODE_FREE.
// Ollama: the coder model for both kinds; llama3.2:3b proved too weak for reviews.
const MODELS = {
  code: { omniroute: 'auto/coding:free', ollama: 'qwen2.5-coder:7b', opencode: OPENCODE_FREE[0] },
  research: { omniroute: 'auto/best-free', ollama: 'qwen2.5-coder:7b', opencode: OPENCODE_FREE[0] },
};
const HOW = {
  code: 'Reply with complete files only, each as a heading line `FILE: <relative path>` followed by one fenced code block. Include a small test file. End with a short "How to run" line. No placeholders or "rest unchanged".',
  research: 'Reply with a short answer first, then the key points as bullets. Say which points you are unsure of. Name sources where you can.',
};

// Flags come first; the first non-flag word (or a bare --) starts the brief, so "--to" inside a brief is just text.
const FLAGS = ['name', 'kind', 'round', 'to', 'file', 'model', 'wait', 'attach'];
const o = { model: [], attach: [] }, a = process.argv.slice(2);
let i = 0;
for (; i < a.length; i += 2) {
  if (a[i] === '--') { i++; break; }
  const k = a[i].startsWith('--') && a[i].slice(2);
  if (!FLAGS.includes(k)) break;
  if (a[i + 1] === undefined) { console.error(`--${k} needs a value`); process.exit(2); }
  Array.isArray(o[k]) ? o[k].push(a[i + 1]) : (o[k] = a[i + 1]);
}
const { name, kind = 'code', round = '1', file, wait = '900' } = o;
let to = (o.to || 'opencode,ollama,omniroute').split(',').map((s) => s.trim()).filter(Boolean);

// Local-only folders (customer data, live keys): their jobs go to Ollama only. Longest matching path wins.
const RULES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'local-only.json');
const rules = fs.existsSync(RULES) ? JSON.parse(fs.readFileSync(RULES, 'utf8')) : { localOnly: [], cloudOk: [] };
// Real paths, so 8.3 names, junctions and symlinks can't slip past the folder rules or the key-file names.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const under = (p, root) => { const r = path.relative(root, p); return !r.startsWith('..') && !path.isAbsolute(r); };
const isLocal = (p) => {
  let best = { len: -1, local: false };
  for (const [list, local] of [[rules.localOnly, true], [rules.cloudOk, false]])
    for (const root of list) if (under(p, real(root)) && root.length > best.len) best = { len: root.length, local };
  return best.local;
};
const inputs = [...o.attach, ...(file ? [file] : [])];
const touched = [real(process.cwd()), ...inputs.map(real)].filter(isLocal);
if (touched.length && to.some((t) => CLOUD.has(t))) {
  if (o.to) { console.error(`refused: ${touched[0]} is a local-only folder (see local-only.json), so cloud agents can't have this job. Use --to ollama.`); process.exit(1); }
  console.error(`local-only folder (${touched[0]}): sending to ollama only`);
  to = ['ollama'];
}
const models = { ...MODELS[kind] };
for (const m of o.model) { const [k, v] = m.split(/=(.*)/s); models[k] = v; }
// Demote ## headings: the bridge ends the task at the next "## " line.
// Key and secrets files are refused by name before anything is read.
const NEVER = /(^|[\\/])([^\\/]*\.env(\.[\w.-]+)?|[^\\/]*\.(pem|key|pfx|p12|p8|kdbx|ppk|jks|keystore|tfvars)|id_(rsa|ed25519|ecdsa)[^\\/]*|[^\\/]*credentials[^\\/]*|[^\\/]*secrets?[^\\/]*|appsettings[^\\/]*\.json|local\.settings\.json|service-account[^\\/]*\.json|\.(npmrc|netrc|pgpass))[\s.]*(::\$DATA)?$/i;
for (const f of inputs)
  if (NEVER.test(f) || NEVER.test(real(f))) { console.error(`refused: ${f} is a secrets or key file and is never sent`); process.exit(1); }
let brief = (file ? fs.readFileSync(file, 'utf8') : a.slice(i).join(' ')).trim();

// --attach puts project files in the brief: agents see only the note, never the project folder.
let total = 0;
for (const f of o.attach) {
  const buf = fs.readFileSync(f);
  if (buf.subarray(0, 8000).includes(0)) { console.error(`refused: ${f} looks binary`); process.exit(1); }
  if ((total += buf.length) > 400_000) { console.error('refused: attachments over 400 KB; attach only the files the job needs'); process.exit(1); }
  const rel = path.relative(process.cwd(), path.resolve(f)).replace(/\\/g, '/');
  brief += `\n\nFILE: ${rel}\n\`\`\`${path.extname(f).slice(1)}\n${buf.toString('utf8').replace(/```/g, '\\`\\`\\`')}\n\`\`\``;
}
// Cloud agents never get credential-shaped text; Ollama runs on this PC and may.
const cloud = to.filter((t) => CLOUD.has(t));
if (cloud.length && hasSecret(brief)) {
  console.error(`refused: the brief or an attached file holds something shaped like a credential, and ${cloud.join(', ')} send prompts to cloud models. Remove it, or use --to ollama.`);
  process.exit(1);
}
// Demote ## headings: the bridge ends the task at the next "## " line.
brief = brief.replace(/^## /gm, '### ');
if (!name || !brief || !HOW[kind]) { console.error('need --name, --kind code|research and a brief'); process.exit(2); }

const day = new Date().toISOString().slice(0, 10);
const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, '-');
const notes = to.map((agent) => path.join(TASKS, `${day} ${safe} - r${round} - ${agent}.md`));
const taken = notes.filter((p) => fs.existsSync(p));
// Check all first, so a clash never leaves half the round written.
if (taken.length) { console.error(`exists, not overwriting (use a new --round or --name):\n${taken.join('\n')}`); process.exit(1); }
to.forEach((agent, n) => {
  const p = notes[n];
  fs.writeFileSync(p, `---\ntype: agent-task\nfrom: claude\nto: ${agent}\nmodel: ${models[agent] || ''}\n${touched.length ? 'local: true\n' : ''}status: open\ngroup: ${safe}\nround: ${round}\nkind: ${kind}\ncreated: ${day}\nhub: "[[Agent hub]]"\ntags: [agent-task]\n---\n\n## Task\n${brief}\n\n${HOW[kind]}\n`, { flag: 'wx' });
});
console.error(`wrote ${notes.length} task note(s); waiting for replies`);

const status = (p) => (fs.readFileSync(p, 'utf8').match(/^status:\s*(\S+)/m) || [])[1];
const deadline = Date.now() + Number(wait) * 1000;
for (;;) {
  // The login watcher normally answers; a one-shot run is a no-op while it is alive.
  spawnSync(process.execPath, [BRIDGE], { stdio: 'ignore' });
  const left = notes.filter((p) => !['answered', 'failed'].includes(status(p)));
  if (!left.length || Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 10000));
}
for (const p of notes) {
  const t = fs.readFileSync(p, 'utf8');
  const i = t.lastIndexOf('\n## Reply');
  console.log(`\n\n######## ${path.basename(p)} [${status(p)}]\n${i >= 0 ? t.slice(i) : '(no reply yet: still running, check the note later)'}`);
}
