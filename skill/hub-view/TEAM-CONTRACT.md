# Agent Hub team: data contract (shared by the bridge and the view)

All local files live in `%LOCALAPPDATA%\agent-hub\` (call it HUB). Nothing here goes into the vault.

## HUB/team.json  (written by scripts/team.mjs --build)
{ "built": "2026-11-11T15:00:00Z",
  "seats": [ { "id": "cfp-qwen-qwen2.5-coder-32b-instruct",   // filesystem-safe, unique
               "runner": "omniroute" | "ollama" | "opencode",
               "model": "cfp/qwen/qwen2.5-coder-32b-instruct",
               "provider": "cfp" | "openrouter" | "groq" | "gemini" | "ddgw" | "ollama" | "opencode",
               "local": false,                                // true only for ollama
               "ok": true,                                    // answered the probe at build time
               "ms": 1830 } ] }                               // probe latency

## HUB/team-state.json  (written by the bridge)
{ "<seatId>": { "downUntil": 1794403685440, "lastError": "429 rate limit", "lastOk": 1794403600000, "wins": 4, "fails": 1 } }
A seat is "cooling" while Date.now() < downUntil.

## HUB/live/<seatId>.json  (written by the bridge while a seat works; rewritten at most every ~400 ms)
{ "seat": "<seatId>", "note": "2026-11-11 job - r1 - <seatId>.md", "job": "job name",
  "status": "thinking" | "writing" | "done" | "failed",
  "thinking": "reasoning text streamed so far (may be empty)",
  "text": "answer text streamed so far",
  "error": "", "started": 1794403600000, "updated": 1794403601234 }
Kept after the job ends (status done/failed) so the last run stays viewable.

## HUB/claude-agents.json  (written by Claude Code SubagentStart/SubagentStop hooks)
{ "<agent_id>": { "type": "general-purpose", "started": 1794403600000, "stopped": null | 1794403700000, "session": "…" } }

## Task notes (vault agents/tasks/*.md) gain frontmatter fields
seat: <seatId>        the seat that ran / is running it (after failover: the last one)
tried: id1,id2        seats that failed before it, in order
`to:` stays the runner (omniroute/ollama/opencode), so old notes keep working.
