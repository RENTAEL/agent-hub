#!/usr/bin/env node
// The hub team: every free model seat the bridge can use, their health, and their live output.
// Usage: node team.mjs --build     probe the free models and write HUB/team.json
//        node team.mjs             list seats and their state
// Files (see the data contract in the obsidian-wiki skill): HUB/team.json, HUB/team-state.json, HUB/live/<seat>.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HUB = process.env.HUB_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'agent-hub');
const TEAM = path.join(HUB, 'team.json'), STATE = path.join(HUB, 'team-state.json'), LIVE = path.join(HUB, 'live');
// Free sources only. Paid Kimi/Moonshot and non-:free OpenRouter models are never seats.
const FREE_PROVIDERS = ['cfp', 'groq', 'gemini', 'ddgw'];
const SKIP = /embed|tts|audio|image|imagen|veo|vision-only|whisper|guard|aqa|live|native-audio|transcribe|moderation|rerank|lyria|nano-banana|antigravity|deep-research|robotics|computer-use|orpheus|safety/i;
export const OPENCODE_SEATS = [
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  'openrouter/nvidia/nemotron-3.5-lightning:free',
  'opencode/nemotron-3.5-lightning-free',
];

export const seatId = (provider, model) => `${provider}-${model.replace(new RegExp(`^${provider}/`), '')}`.replace(/[^\w.-]+/g, '-').slice(0, 80);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
// Write to a temp file and rename, so a reader never sees half a file.
// On Windows the rename fails (EPERM) while the view has the file open, so retry, then write in place (readers tolerate that).
export const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = `${p}.${process.pid}.tmp`, s = JSON.stringify(v, null, 1);
  fs.writeFileSync(t, s);
  for (let i = 0; i < 4; i++) {
    try { fs.renameSync(t, p); return; } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1)); // short sync back-off: a reader holds the file for milliseconds
  }
  fs.writeFileSync(p, s);
  fs.rmSync(t, { force: true });
};

export const loadTeam = () => readJson(TEAM, { seats: [] }).seats || [];
export const loadState = () => readJson(STATE, {});

// Record a seat's result. Quota and rate errors cool the seat for 30 minutes, other errors for 5.
export function markSeat(id, ok, error = '') {
  const s = loadState(), e = s[id] || { wins: 0, fails: 0 };
  if (ok) Object.assign(e, { wins: e.wins + 1, lastOk: Date.now(), downUntil: 0 });
  else Object.assign(e, { fails: e.fails + 1, lastError: String(error).slice(0, 300), downUntil: Date.now() + (/\b429\b|\b402\b|rate.?limit|too many requests|quota|credit|exhaust|per.?day|cooling down/i.test(error) ? 30 : 5) * 60000 });
  s[id] = e;
  writeJson(STATE, s);
}

// Live output of a seat, throttled to one write per 400 ms (the final write always lands).
export function liveWriter(seat, note, job) {
  const rec = { seat, note, job, status: 'thinking', thinking: '', text: '', error: '', started: Date.now(), updated: Date.now() };
  let last = 0, timer = null;
  const flush = () => { timer = null; last = Date.now(); rec.updated = last; try { writeJson(path.join(LIVE, `${seat}.json`), rec); } catch { /* the view is optional */ } };
  const push = () => { if (Date.now() - last > 400) flush(); else timer ||= setTimeout(flush, 400); };
  flush();
  return {
    think(t) { rec.thinking += t; push(); },
    write(t) { rec.status = 'writing'; rec.text += t; push(); },
    end(ok, error = '') { clearTimeout(timer); rec.status = ok ? 'done' : 'failed'; rec.error = String(error).slice(0, 500); flush(); },
  };
}

export function gatewayKey() {
  const k = process.env.OMNIROUTE_API_KEY || process.env.LMSTUDIO_API_KEY;
  if (k) return k;
  if (process.platform !== 'win32') return '';
  return execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('LMSTUDIO_API_KEY','User')"], { windowsHide: true }).toString().trim();
}

async function probe(model, key) {
  const t0 = Date.now();
  try {
    const r = await fetch('http://localhost:20128/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }),
    });
    const j = await r.json().catch(() => ({}));
    const m = j.choices?.[0]?.message;
    return { ok: r.ok && !!(m?.content || m?.reasoning_content || m?.reasoning), ms: Date.now() - t0, error: r.ok ? '' : String(j.error?.message || j.error || r.status).slice(0, 200) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message.slice(0, 200) }; }
}

async function build() {
  const key = gatewayKey();
  const ids = (await fetch('http://localhost:20128/v1/models', { headers: key ? { authorization: `Bearer ${key}` } : {} }).then((r) => r.json())).data.map((m) => m.id);
  const cloud = ids.filter((id) => !SKIP.test(id) && (/^openrouter\/.*:free$/.test(id) || FREE_PROVIDERS.includes(id.split('/')[0])));
  const seats = [];
  // Probe six at a time: enough to finish in a minute or two without tripping provider rate limits.
  for (let i = 0; i < cloud.length; i += 6) {
    const batch = cloud.slice(i, i + 6);
    const res = await Promise.all(batch.map((m) => probe(m, key)));
    batch.forEach((model, k) => {
      const provider = model.split('/')[0];
      seats.push({ id: seatId(provider, model), runner: 'omniroute', model, provider, local: false, ok: res[k].ok, ms: res[k].ms, ...(res[k].ok ? {} : { probeError: res[k].error }) });
      console.error(`${res[k].ok ? 'ok  ' : 'down'} ${String(res[k].ms).padStart(6)}ms ${model}${res[k].ok ? '' : `  (${res[k].error})`}`);
    });
  }
  const tags = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => ({ models: [] }));
  // Local seats are not probed: loading each model onto the GPU just to say OK takes minutes.
  // Rank: the biggest model that still fits the 8 GB GPU goes first (bigger = stronger); ones that spill into RAM go last.
  // shortcut: VRAM is fixed at 8 GB here; read it from nvidia-smi if this ever runs on another PC.
  for (const m of tags.models || []) {
    if (/embed/i.test(m.name)) continue;
    const mb = Math.round(m.size / 1e6), fits = mb <= 7000;
    seats.push({ id: seatId('ollama', m.name), runner: 'ollama', model: m.name, provider: 'ollama', local: true, ok: true, ms: fits ? 20000 - mb : 40000 + mb, sizeMb: mb });
  }
  // OpenCode seats share one daily free quota, so they are not probed either; failures cool them down.
  for (const m of OPENCODE_SEATS) seats.push({ id: seatId('opencode', m), runner: 'opencode', model: m, provider: 'opencode', local: false, ok: true, ms: 60000 });
  writeJson(TEAM, { built: new Date().toISOString(), seats });
  console.log(`${seats.length} seats, ${seats.filter((s) => s.ok).length} ok -> ${TEAM}`);
}

const MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (MAIN && process.argv.includes('--build')) await build();
else if (MAIN) {
  const st = loadState();
  for (const s of loadTeam()) console.log(`${s.ok ? (st[s.id]?.downUntil > Date.now() ? 'cool' : 'ok  ') : 'down'} ${s.provider.padEnd(10)} ${s.id}  w${st[s.id]?.wins || 0}/f${st[s.id]?.fails || 0}`);
}
