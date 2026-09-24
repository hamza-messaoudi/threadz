# NOTES

## Plan changes (findings that override the plan)

1. **No gateway wrapper exists on this machine yet.** `~/bin/claude-gw` is missing, so the spike ran plain `claude` (v2.1.281). `claudeBin` defaults to `claude` when the config does not set it; point it at the wrapper once it exists. Q9 (wrapper stdout/exit code) must be re-checked then.
2. **`--append-system-prompt` is ignored on `--resume`.** The session keeps the system prompt it was created with (Q6). The plan's "keep resuming after an agent file changes" would silently keep the *old* prompt. Changed: when `flags_hash` differs, the app starts a **new seeded session** and marks the message "new session: agent config changed". (`--model` *is* honoured on resume, but it is folded into the same hash for simplicity.)
3. **A project's `disableAllHooks: true` switches our gate off** (Q7). Fix: `gate-settings.json` sets `"disableAllHooks": false`. `--settings` outranks project and local settings, and this was verified to re-enable the hook.
4. **Hook exit 1 does not block** (the tool runs). The hook therefore exits 2 on every error path (hard rule 4 already required this).
5. **The subagent tool is called `Agent` in hook input**, while the init tool list says `Task`. The gate treats both names the same. Hooks fire inside subagents (`agent_id` is set), so they are allowed in read-only mode.
6. **This CLI version has no `LS`/`Glob`/`Grep` tools**, but it adds `ToolSearch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`, `TaskCreate/Get/List/Update` (todo list), `LSP`, `ReportFindings`. These read-only tools are on the gate's built-in allow list. `ToolSearch` is always allowed, even when an agent has a `tools` list, because deferred MCP tools cannot be called without it.
7. **Cache badge uses the first API call of the turn**, not the result's cumulative usage. Later calls in a multi-call turn re-read the earlier ones and inflate the ratio.
8. **Child env is cleaned.** When the app runs inside a Claude Code session, `CLAUDECODE`, `CLAUDE_CODE_*` session variables etc. are inherited; the runner strips them before spawning.
9. **Hook file.** The gate hook is written in TypeScript (`server/gate/hook.ts`, sharing `classify.ts`) and bundled by esbuild to `dist/hook.mjs`, so it loads with no dependencies at runtime. `npm run dev`, `npm run build` and the test setup build it.
10. **ADO profile detection** uses word boundaries for `ado` (`/(^|[^a-z])ado([^a-z]|$)/i`); a plain `/ado/i` would match names such as `shadow`.
11. **Legacy ADO write names** are denied when the first *or second* underscore-separated word is a write verb (`wit_create_work_item` has the verb second).
12. **Extra message columns**: `cwd`, `session_id`, `markers` (JSON), `mentions` (JSON), `meta` (JSON) on `messages`; `thread_id`, `meta` on `runs`. Needed for "Open in terminal", session markers, workflow cards and routine headers.
13. **Gate inventory** cannot avoid Claude's first model call entirely: the CLI only emits `init` after it has a prompt, and `--max-turns 0` still calls the model. The inventory sends "Reply with: ok" and kills the process group as soon as `init` arrives, so at most one tiny call starts.
14. **Routine freshness** is done by deleting the channel's sessions at the start of a run and, in routine channels, seeding new sessions only from messages after the latest run header. This gives the same result as "no `--resume`, cursor at the header" and also covers every agent in a workflow target.

## Phase 0 answers (Claude Code 2.1.281, model alias `haiku`)

| # | Answer |
| --- | --- |
| 1 | Event types seen: `system/init`, `system/hook_started`, `system/hook_response`, `system/status`, `system/thinking_tokens`, `stream_event` (only with `--include-partial-messages`), `assistant` (one per content block, each carries full `message.usage`), `user` (tool results, with `tool_use_result`), `rate_limit_event`, `result`. `--include-partial-messages` gives raw Anthropic stream events: `message_start`, `content_block_start/delta/stop` with `text_delta`, `thinking_delta`, `input_json_delta`, `signature_delta`. Fixture: `basic.jsonl`. Prompt on **stdin works**. |
| 2 | `init`: `session_id`, `cwd`, `model` (resolved id), `tools` (string array), `mcp_servers` (`[{name,status,source}]`), `permissionMode`, `claude_code_version`. `result`: `session_id`, `is_error`, `subtype`, `result` (final text), `usage.{input_tokens,cache_read_input_tokens,cache_creation_input_tokens,output_tokens}` (cumulative), `usage.iterations[]`, `permission_denials[]`, `total_cost_usd`, `duration_ms`. |
| 3 | `--resume <id>` keeps the same session id. Turn 2: 25,262 cache read / 83 creation / 9 input = **99.6 % hit**. |
| 4 | `--resume <id> --fork-session` returns a new id; parent `.jsonl` byte-identical afterwards; fork turn 25,345 read / 69 creation = **99.7 % hit**. Fixture `fork.jsonl`. |
| 5 | Yes. Resuming from a subdirectory and from an unrelated sibling directory both worked, with history intact (init reports the new cwd). |
| 6 | Same flags: hit (99.7 %). Changed env vars (`AGENT_MODE`, arbitrary): hit (99.7 %). Changed `--append-system-prompt`: still a "hit" because **the new text is ignored** (model still reports the original agent name) — see plan change 2. Changed `--model` on resume: model switches, full miss (0 read). Repo `git status` changed (new file, modified file, new commit) between turns: hit (99.6 %). |
| 7 | With `bypassPermissions` + `--settings` PreToolUse hook (matcher `*`): exit 2 blocks and the model sees `PreToolUse:Write hook error: [cmd]: <stderr>` as an `is_error` tool result; the call also appears in `result.permission_denials`. Exit 1 does **not** block. Hooks fire for MCP tools (input has `mcp_server`) and inside subagents (input has `agent_id`; outer tool name is `Agent`). A project `.claude/settings.json` or `settings.local.json` with `disableAllHooks: true` **disabled** our hook; adding `"disableAllHooks": false` to our `--settings` file restores it. Hook stdin keys: `session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, tool_name, tool_input, tool_use_id` (+ `mcp_server`, `agent_id`). Fixtures `hook-deny.jsonl`, `mcp-and-subagent.jsonl`. |
| 8 | GitHub and Azure DevOps MCPs are **not configured** on this machine (the GitHub plugin server is `needs-auth`), so the inventory could not be dumped. Observed naming: server `plugin:engineering:github` → tools `mcp__plugin_engineering_github__<tool>`; `claude.ai Notion` → `mcp__claude_ai_Notion__<tool>`. Run `npm run gate:inventory -- --dir <repo>` once the servers are set up. |
| 9 | Plain `claude`: every stdout line is valid JSON (all fixtures parse with `jq`). Exit 0 on success, exit 1 on errors; errors still emit a `result` event with `is_error: true` (`error-resume-missing.jsonl`: `subtype: error_during_execution`, stderr `No conversation found with session ID`; `error-bad-model.jsonl`: synthetic assistant message + result). Wrapper not available — re-check. |
| 10 | One `claude` process, no local MCP children here (all MCPs are remote): peak RSS **~285 MB** per turn; first stdout event after **0.7–1.0 s**; trivial turn 5–6 s total. Default `maxConcurrent: 4` means up to ~1.2 GB during bursts. |
| 11 | `process.kill(-pgid, 'SIGTERM')` on a `detached` spawn ends the turn (exit 143), leaves no processes in the group, and the session resumes afterwards with the interrupted prompt in its history. No `result` event is emitted on kill. |
| 12 | `haiku` → `claude-haiku-4-5-20251001`, `sonnet` → `claude-sonnet-5`, `opus` → `claude-opus-5-5`. Unknown model → exit 1 with `result.is_error`. |

Other observations:

- The user's own `SessionStart` hooks run for every spawned turn (8 hook events per turn here). They cost startup time, not tokens in our prompt budget.
- A brand-new session costs ~25 k prompt tokens (≈12 k cached from a global prefix). Follow-up turns are ~99 % cache reads.
- Denied tool results start with `PreToolUse:` and contain `hook error:`; the parser uses this to mark chips as denied.

## Cache-hit numbers from real runs

All through plain `claude` (no wrapper), model `haiku`, badge = first API call of the turn.

| Phase | Check | Result |
| --- | --- | --- |
| 2 | Turn 1 (new session) | 44 % (12,311 read / 15,439 write) — the global prefix is shared |
| 2 | Turn 2, `--resume` | **99 %** (27,750 read / 399 write) |
| 3 | Two agents tagged together, turn 2 | researcher 98.6 % (27,750 / 395), writer 98.8 % (27,750 / 321) |
| 3 | Same thread, turn 3 | researcher **99 %** (28,145 / 293), writer **99 %** (28,071 / 288); replies reference each other |
| 4 | Read-only: "edit notes.txt" | `Edit` denied (lock chip), agent explains YOLO is needed; file unchanged |
| 4 | Flip YOLO, same session, "make that edit now" | edit succeeds, **99.4 %** (26,085 / 146), same session id |
| 4 | ADO work item / GitHub PR reads | **not run**: neither MCP server is configured on this machine (see Q8) |
| 5 | Selection spanning two paragraphs (browser) | snapped to paragraph 1; panel opened with that quote; URL `?thread=` |
| 5 | First thread reply (untagged → source agent) | forked, **98 %**; answered with a detail only in the earlier main discussion (MySQL/PostgreSQL indexing) |
| 2 | Stop during `sleep 40` Bash call | `claude` and the Bash tool's shell (its own process group) both gone 3 s after SIGTERM to the group; message `cancelled` |

## Memory

(filled in during Phase 9)
