#!/usr/bin/env node
// Claude Code SubagentStart / SubagentStop hook: logs Claude's own helper agents so the hub map can show them.
// Writes HUB/claude-agents.json (see the team data contract). Never blocks Claude: always exits 0, prints nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HUB = process.env.HUB_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'agent-hub');
const FILE = path.join(HUB, 'claude-agents.json');
const DAY = 24 * 3600 * 1000;

export function apply(log, ev, now = Date.now()) {
  const id = String(ev.agent_id || ev.subagent_id || ev.tool_use_id || '').slice(0, 100);
  if (!id) return log;
  const out = {};
  // Keep the last day, at most 200 entries; an entry still running for over a day is a crash leftover.
  for (const [k, v] of Object.entries(log || {})) if (v && now - (v.stopped || v.started || 0) < DAY) out[k] = v;
  if (ev.hook_event_name === 'SubagentStart') out[id] = { type: String(ev.agent_type || ev.subagent_type || 'agent').slice(0, 60), started: now, stopped: null, session: String(ev.session_id || '').slice(0, 60) };
  else if (ev.hook_event_name === 'SubagentStop') out[id] = { ...(out[id] || { type: String(ev.agent_type || 'agent').slice(0, 60), started: now, session: String(ev.session_id || '').slice(0, 60) }), stopped: now };
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].started - a[1].started).slice(0, 200));
}

if (process.argv.includes('--test')) {
  const assert = (await import('node:assert')).default;
  let l = apply({}, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', session_id: 's' }, 1000);
  assert.equal(l.a1.type, 'Explore'); assert.equal(l.a1.stopped, null);
  l = apply(l, { hook_event_name: 'SubagentStop', agent_id: 'a1' }, 2000);
  assert.equal(l.a1.stopped, 2000); assert.equal(l.a1.started, 1000);
  l = apply(l, { hook_event_name: 'SubagentStop', agent_id: 'b2' }, 3000); // stop without a start still shows
  assert.equal(l.b2.stopped, 3000);
  assert.deepEqual(Object.keys(apply(l, { hook_event_name: 'SubagentStart', agent_id: 'c3' }, 3000 + DAY)), ['c3']); // old ones age out
  assert.deepEqual(apply(l, {}, 4000), l); // no id: unchanged
  console.log('hook tests pass');
} else {
  let input = '';
  try { for await (const c of process.stdin) input += c; } catch {}
  try {
    const ev = JSON.parse(input || '{}');
    let log = {};
    try { log = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    // Temp file + rename, so a reader never sees half a file and wipes the log. Two hooks at the same instant
    // can still drop one entry (read-modify-write); the map only loses a dot.
    const { writeJson } = await import('./team.mjs');
    writeJson(FILE, apply(log, ev));
  } catch { /* the map is optional: never fail Claude's run */ }
  process.exit(0);
}
