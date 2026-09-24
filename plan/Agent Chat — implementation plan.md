# Agent Chat — implementation plan

Sep 23, 2026 · @sedik

## How to use this plan

Build in ten phases (0 to 9), in order. Each phase ends with a running app, passing tests and a commit. Do not start a phase until the previous phase's acceptance checks pass.

Phase 0 is a spike that verifies Claude Code CLI behaviour this plan depends on. Record results in `NOTES.md`. If a finding contradicts this plan, the finding wins: adapt the design, and note the change at the top of `NOTES.md`.

**Goal.** A local, single-user, Slack-like web app for chatting with Claude Code agents. It has channels, ad-hoc chats, @-tagged agents and workflows, paragraph threads, and daily and weekly routines. All model work is done by headless Claude Code (`claude -p`) through the user's gateway wrapper script. The app is a visualizer and orchestrator, never a model client.

**Out of scope for v1:** file and image attachments, nested threads (data model allows them, UI does not), human-in-the-loop workflow steps, a terminal view, remote access, merging threads back into the main timeline, agents tagging agents, schedules other than daily and weekly, desktop notifications, a warm process pool (config key exists, default 0).

### Hard rules (apply to every phase)

1. **Cache stability.** For a given session, every turn is spawned with identical flags: same binary, `--model`, `--append-system-prompt` text, `--settings` file, `--permission-mode`, MCP configuration and working directory. Anything that varies per turn goes in environment variables or the prompt text, never in flags.
2. **Append-only context.** Never re-send history into an existing session. A new turn carries only the messages the agent has not seen yet, plus the new message. Full history is rendered only when seeding a brand-new session (see Phase 3).
3. **Lightweight.** One Node process serves API, static files, scheduler and runner. Target idle memory under 150 MB. No Claude process stays alive when nothing is running. Default `maxConcurrent: 4`; extra turns queue.
4. **Fail closed.** Any error in the permission hook blocks the tool call.
5. **Localhost only.** Bind `127.0.0.1`, check `Host` and `Origin`, require the startup token.
6. **Claude Code owns the model side.** No direct Anthropic API calls and no custom compaction; rely on Claude Code's auto-compaction.

## Phase 0: CLI spike (verify before building)

Output: `NOTES.md` answering every question below, plus recorded event streams under `test/fixtures/stream/`. Use the user's wrapper script (`claudeBin` in config) for every call, never plain `claude`. Keep prompts tiny to save usage.

| # | Question | How to check | Why it matters |
| --- | --- | --- | --- |
| 1 | Exact event shapes of `-p --output-format stream-json --verbose` (init, assistant, tool use, tool result, result). Does `--include-partial-messages` give token deltas? | Run one prompt that triggers a `Read`; save raw output as `basic.jsonl` | Parser and streaming UI |
| 2 | Where are `session_id`, tool list, MCP servers, cwd and model in the init event? Where are `usage.cache_read_input_tokens` and `cache_creation_input_tokens` in the result event? | Inspect fixture | Session mapping, cache badge |
| 3 | Does `--resume <id>` keep the same session ID? Is turn 2 mostly cache reads? | Two turns, compare usage | Session table, cache rule |
| 4 | Does `--resume <id> --fork-session` return a new ID, leave the parent transcript unchanged, and still hit the cache? | Fork, diff the parent `.jsonl` | Paragraph threads |
| 5 | Can a session be resumed from a different cwd? | Resume from another dir | Session key includes cwd |
| 6 | Cache stability: same flags → hit; changed `--append-system-prompt` → miss; changed env var → hit; repo `git status` changed between turns → hit or miss? | Four paired runs | Hard rule 1, read-only toggle |
| 7 | With `--permission-mode bypassPermissions` plus a PreToolUse hook from `--settings`: does exit code 2 block and show stderr to the model? Does exit 1 let the tool run? Do hooks fire for MCP tools and for subagent (`Task`) tool calls? Can a project's `disableAllHooks` setting switch our hook off? | Hook that logs and blocks `Write` | Phase 4 safety gate |
| 8 | Full tool-name inventory in a directory where the GitHub and Azure DevOps MCPs are configured (user and project scope) | Dump the init event's tool list | Phase 4 allowlist patterns |
| 9 | Does the wrapper keep stdout as clean JSON lines and pass the exit code through? | Pipe through `jq` | Parser robustness |
| 10 | Memory and startup: RSS of one Claude process plus its MCP children during a turn; time to first event | `ps`/`smem` while running | Concurrency defaults |
| 11 | Cancel: does SIGTERM to the process group stop the turn, clean up MCP children, and leave the session resumable? | Spawn detached, kill `-pgid`, resume | Stop button |
| 12 | Are model aliases (`sonnet`, `opus`, `haiku`) accepted by `--model` through the gateway? | One call each | Agent frontmatter |

Acceptance: every row answered in `NOTES.md`, fixtures saved, and a short list of plan changes (if any) at the top of `NOTES.md`.

## Repo layout, stack and config

One npm package, TypeScript everywhere, one runtime process in production.

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node 22+ LTS | `tsx` in dev, esbuild bundle for prod |
| HTTP | Hono + `@hono/node-server` | REST + Server-Sent Events |
| DB | `better-sqlite3`, WAL mode, FTS5 | Plain SQL migrations, no ORM |
| Config | `yaml`, `gray-matter`, `fs.watch` | No chokidar |
| Web | Vite + React, plain CSS variables | No UI kit |
| Markdown | `marked` + DOMPurify + highlight.js (common languages only) | `marked.lexer` gives top-level blocks for threads |
| Gate | `shell-quote`, `picomatch` | Bash parsing and tool globs |
| Tests | Vitest + a fake `claude` binary | No tokens spent in CI |

```
agent-chat/
  server/
    index.ts            Hono app, static files, auth, SSE hub
    db/                 schema.sql, migrate.ts, queries.ts
    config/             load.ts, validate.ts, watch.ts
    runner/             spawn.ts, parse.ts, queue.ts, locks.ts
    context/            mentions.ts, delta.ts, seed.ts
    gate/               hook.mjs, classify.ts, readonly.default.yaml
    scheduler/          due.ts, scheduler.ts
    dirs/               scan.ts, search.ts
  web/                  index.html, src/ (components, lib/markdown.ts, lib/sse.ts)
  test/                 fake-claude.mjs, fixtures/stream/, *.test.ts
  NOTES.md
```

Config lives in `~/.config/agent-chat/`; data (SQLite file, scratch dir, hook log) in `~/.local/share/agent-chat/`. The app never writes config files. Invalid files show in a "config problems" banner instead of crashing the server.

```yaml
# ~/.config/agent-chat/config.yaml
claudeBin: ~/bin/claude-gw        # the gateway wrapper
port: 4777
maxConcurrent: 4                  # turns running at once; extra ones queue
keepWarm: 0                       # reserved; v1 always spawns per turn
defaultModel: sonnet
scratchDir: ~/.local/share/agent-chat/scratch
dirRoots: [~/code, ~/work]        # scanned for #dir autocomplete
dirScanDepth: 2
routineCheckMinutes: 10
```

```markdown
<!-- ~/.config/agent-chat/agents/researcher.md (Claude Code agent format) -->
---
name: researcher
description: Digs into topics and cites sources
model: sonnet
tools: [Read, Grep, WebSearch, "mcp__ado__*"]   # optional, enforced by the gate
---
You are a research agent...
```

```yaml
# workflows/research-to-brief.yaml
name: research-to-brief
description: Research a topic, then write a one-page brief
steps:
  - agent: researcher
    prompt: "Research this using the web-research skill: {{input}}"
  - agent: writer
    prompt: "Turn the research above into a one-page brief."
```

```yaml
# routines/ado-standup.yaml
name: ado-standup
schedule: { daily: "07:00" }      # or { weekly: "mon 07:00" }
channel: routine-ado-standup       # created automatically
target: agent:researcher           # or workflow:research-to-brief
dir: ~/work/main-repo              # optional; default scratchDir
yolo: false
prompt: "Summarise my active ADO work items and PRs needing review."
```

Agent and workflow names share one `@` namespace and must be unique; duplicates are a config error.

## Data model

SQLite is the source of truth for what the user sees; Claude's own transcript files are the source of truth for model context. Every conversation has exactly one root thread, so "the main timeline" and "a paragraph thread" use the same code path.

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('channel','chat','routine')),
  name TEXT NOT NULL,
  dir TEXT,                          -- NULL = scratchDir
  yolo INTEGER NOT NULL DEFAULT 0,   -- sticky per conversation
  routine_id TEXT,                   -- set when kind = 'routine'
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_thread_id TEXT REFERENCES threads(id),   -- NULL = root thread
  parent_message_id TEXT REFERENCES messages(id),
  block_index INTEGER,
  block_text TEXT,                   -- snapshot of the paragraph
  created_at INTEGER NOT NULL,
  UNIQUE (parent_message_id, block_index)          -- one thread per paragraph
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,               -- ULID, sortable
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_id TEXT,                    -- agent name, workflow name or NULL
  content_md TEXT NOT NULL DEFAULT '',
  tool_events TEXT,                  -- JSON array of {name, input, output_preview, denied}
  status TEXT NOT NULL CHECK (status IN ('queued','streaming','done','error','cancelled')),
  error TEXT,
  usage TEXT,                        -- JSON from the result event
  run_id TEXT,
  done_seq INTEGER UNIQUE,           -- monotonic, assigned when status becomes done
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, id);

CREATE TABLE agent_sessions (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  agent_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  claude_session_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,  -- delta cursor over messages.done_seq
  flags_hash TEXT NOT NULL,          -- hash of spawn flags; mismatch = new session
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, agent_id, cwd)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('turn','workflow','routine')),
  status TEXT NOT NULL,
  parent_run_id TEXT,
  started_at INTEGER, finished_at INTEGER, error TEXT
);

CREATE TABLE routine_state (
  routine_id TEXT PRIMARY KEY,
  last_success_slot INTEGER,         -- the scheduled slot that last succeeded
  last_attempt_at INTEGER,
  last_error TEXT
);

CREATE TABLE dirs_recent (path TEXT PRIMARY KEY, used_at INTEGER NOT NULL);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_md, content='messages', content_rowid='rowid'
);
-- plus insert/update/delete triggers keeping messages_fts in sync
```

`flags_hash` records the spawn flags used for a session. When an agent file changes (new prompt or model), keep resuming the same session: the next turn is uncached once but keeps the real history, tool results included. Update the hash and show a small "cache reset: agent config changed" marker in the thread so cost jumps are explainable.

## Phase 1: skeleton server, web app and auth

Goal: `npm run dev` and `npm start` both work, the UI shows an empty sidebar, and nothing can reach the API without the token.

1. Scaffold the layout above. Scripts: `dev` (tsx watch + Vite dev server with proxy), `build` (Vite build + esbuild server bundle), `start` (single Node process serving `web/dist`).
2. Config loader: read `config.yaml`, agents, workflows, routines; validate; expand `~`; watch the folders and hot-reload. Expose `GET /api/config` (agents, workflows, routines, problems).
3. Database: open with WAL, run migrations from `schema.sql`, keep one connection.
4. Security:
   - Bind `127.0.0.1` only.
   - On startup generate a random token, print `http://127.0.0.1:4777/?t=<token>` and store it in `~/.local/share/agent-chat/token` so the URL stays the same across restarts.
   - Frontend moves the token from the query string into an `HttpOnly`, `SameSite=Strict` cookie via `POST /api/login`.
   - Every API request: reject if `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, if `Origin` is present and not the same origin, or if the cookie is missing.
5. Web shell: sidebar sections Channels, Chats, Routines; empty main pane; right-hand panel slot for threads; config-problems banner.
6. CRUD for conversations: create channel (name, optional dir), create chat, rename, archive. Creating a conversation also creates its root thread.

Acceptance:

- [ ] Idle server RSS under 150 MB after startup
- [ ] Request with wrong `Host` or missing cookie gets 403 (test)
- [ ] Editing an agent file updates `/api/config` without restart

## Phase 2: runner and streaming

Goal: one agent in one channel, replies stream token by token, the second message resumes the session, and the cache badge proves it.

**Spawn (`runner/spawn.ts`).** Build arguments in a fixed order from a pure function `buildArgs(agent, session, mode)` so identical inputs give byte-identical flags:

```
<claudeBin> -p --output-format stream-json --verbose [--include-partial-messages]
  --model <agent.model> --append-system-prompt <agent.body>
  --settings <dataDir>/gate-settings.json --permission-mode bypassPermissions
  [--resume <sessionId> [--fork-session]]
```

- Prompt goes on stdin (fall back to a positional argument if Phase 0 shows stdin is unsupported).
- `cwd` = resolved working directory. Per-turn values go in env: `AGENT_MODE`, `AGENT_TOOLS`, `AGENT_CHAT_RUN_ID`, `AGENT_CHAT_GATE_CONFIG`.
- Spawn `detached: true`; cancel kills the whole process group so MCP children die too. Keep the last 4 KB of stderr for error display.

**Parse (`runner/parse.ts`).** Line-buffered JSON into internal events: `init {sessionId, tools}`, `textDelta`, `toolUse {id, name, input}`, `toolResult {id, preview (2 KB), isError, denied}`, `result {usage, isError}`. Unknown event types are ignored and logged at debug level. Build this against the Phase 0 fixtures.

**Persist and stream.**

- Create the agent message row as `streaming`, flush text and tool events to SQLite every 500 ms and at the end.
- SSE hub: `GET /api/threads/:id/events` pushes `message.created`, `message.delta`, `message.tool`, `message.done`, `thread.created`. On reconnect the client refetches the thread over REST, then resubscribes; no replay log needed.
- Store `session_id` from the init event on every turn (whether or not it changed).

**Queue (`runner/queue.ts`, `locks.ts`).** A global semaphore of `maxConcurrent` plus a FIFO mutex per session key `(thread, agent, cwd)`. Queued messages show status `queued` in the UI.

**UI.**

- Message list with markdown and syntax highlighting. Tool calls render as collapsed chips ("Read src/app.ts"); expanding shows input and the output preview. Denied calls show a lock icon.
- Stop button on a streaming message: `POST /api/messages/:id/cancel`.
- Cache badge per agent message: `cache_read / (cache_read + cache_creation + input)` as a percentage, tooltip with raw token counts.

**Fake Claude (`test/fake-claude.mjs`).** Replays a fixture named by `FAKE_FIXTURE`, returns a deterministic session ID, and appends its argv, cwd and env to a log file so tests can assert on exact flags.

Acceptance:

- [ ] Real run through the wrapper streams visibly token by token
- [ ] Second turn uses `--resume` and shows a cache hit above 80%
- [ ] Stop kills the process group; no orphan MCP processes (`ps` check)
- [ ] Test: `buildArgs` is deterministic; two turns on one session produce identical flags except `--resume`

## Phase 3: channels, chats and multi-agent context

Goal: several agents in one thread, tagged in parallel, each seeing the others' replies exactly once, with every follow-up turn a cache hit.

**Mentions (`context/mentions.ts`).** The composer inserts mentions as chips and sends `{text, mentions: [{kind: 'agent'|'workflow'|'dir', id, start, end}]}`. The server trusts this structure and falls back to regex parsing only for plain pasted text. The text sent to Claude keeps `@researcher` as readable words.

**Who runs.**

- Tagged agents each get their own run, in parallel. Tagged workflows go to Phase 7.
- An untagged message goes to the last agent that replied in this thread, if any; otherwise it is just posted. The composer shows a hint ("→ @researcher") so this is never a surprise.

**Working directory.** `#dir` mention, else the conversation's `dir`, else `scratchDir`.

**Ordering fix: `done_seq`.** Parallel agents finish out of order, so a message-ID cursor would skip replies. Every message gets a monotonic `done_seq` when it reaches `done` (user messages on creation). The session cursor is `last_seen_seq`.

**Session resolution for `(thread, agent, cwd)`:**

1. Session exists → `--resume`; prompt = delta + new message.
2. Paragraph thread and the parent thread has a session for `(agent, cwd)` → fork (Phase 5).
3. Otherwise → new session seeded with a transcript: the thread's done messages (last 60 messages or 40,000 characters, newest kept, tool calls omitted), plus, for paragraph threads, the parent thread up to the source message. Mark the message with a "new session" marker in the UI.

**Delta format (`context/delta.ts`).** Messages with `done_seq > last_seen_seq`, not authored by this agent, status `done`, in order:

```
<thread_update>
[you 09:14] can you two compare approaches?
[agent:researcher 09:15] Here's what I found... (final text only)
</thread_update>

<message from="you">
@writer draft a summary of the above
</message>
```

After the turn completes, set `last_seen_seq` to the highest seq included in that prompt, not the global maximum, so replies that landed during the turn are delivered next time.

**UI.**

- `@` autocomplete lists agents and workflows with descriptions; keyboard navigation; chips are deletable as one unit.
- Per-agent colour, status (queued, working, done, error) on each message.
- "New chat" creates a `chat` with no dir, named from the first 40 characters of the first message.
- Channel settings panel: name and directory (plain validated text field until Phase 6).

Acceptance:

- [ ] Test: two agents tagged together run concurrently (fake Claude with delays) and finish in reverse order; on the next turn each receives the other's reply exactly once (assert on logged stdin)
- [ ] Test: seed transcript truncation keeps the newest messages and respects both limits
- [ ] Real run: third turn in a two-agent thread shows cache hit above 80% for both agents

## Phase 4: read-only gate and YOLO

Goal: agents can read everything (files, web, GitHub, Azure DevOps, `gh`, `az`) but change nothing until the conversation's YOLO switch is on, and flipping the switch never breaks the cache.

**Mechanism.** Every run already uses `--permission-mode bypassPermissions` and `--settings gate-settings.json`, which registers one PreToolUse hook (`gate/hook.mjs`, matcher `*`). The hook reads `AGENT_MODE` (`readonly` or `yolo`) and `AGENT_TOOLS` from env, so the flags never change.

- Deny = exit code 2 with a one-line reason on stderr (the model sees it and adapts). Allow = exit 0.
- Fail closed: the whole script sits in try/catch; any exception, unreadable config, or missing `AGENT_MODE` exits 2.
- The server compiles `readonly.yaml` into `gate.json` on startup and on change; the hook loads only that JSON, so it stays fast.
- Every decision is appended to `hook.log` (JSONL with run ID), and denied calls show as lock chips on the message.
- In YOLO mode the hook still enforces the agent's optional `tools` list but allows everything else.

**Do not use the servers' own read-only modes to toggle.** GitHub's MCP server has `GITHUB_READ_ONLY` / `X-MCP-Readonly` and it disables all tools that are not read-only ([source](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)). The remote Azure DevOps MCP server has an `X-MCP-Readonly` header ([source](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server?view=azure-devops)). Both remove write tools from the tool list, which changes the prompt prefix and breaks the cache every time YOLO flips. They are fine as a permanent extra layer only if the app should never write to GitHub or ADO.

### Rules, in priority order

1. Explicit `allow` / `deny` overrides in `readonly.yaml` (exact names or globs). Deny wins over allow.
2. Built-in tools. Allow: `Read`, `Grep`, `Glob`, `LS`, `WebSearch`, `WebFetch`, `TodoWrite`, `Skill`, `NotebookRead`, `BashOutput`, and `Task` (only if Phase 0 confirms hooks fire inside subagents; otherwise deny). Deny: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `KillShell`, and any other built-in not listed.
3. MCP tools (`mcp__<server>__<tool>`), by the server's profile. Profiles are auto-detected from the server name (`/github/i` → github, `/ado|azure|devops/i` → azure-devops) or set in `readonly.yaml`. Servers with no profile are denied unless listed.
4. `Bash`: only the command allowlist below.

**Azure DevOps profile.** The current Microsoft server groups operations into tools with an `action` parameter, and puts writes in tools ending in `_write` ([source](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server?view=azure-devops)). Rules:

- Deny names ending in `_write`, plus `repo_create_branch` and `wiki_upsert_page`.
- Deny older one-operation names whose first word is a write verb: `create`, `update`, `add`, `delete`, `link`, `unlink`, `vote`, `reply`, `run`, `queue`, `upsert` (for example `wit_create_work_item`, `repo_update_pull_request`).
- Everything else is allowed, such as `wit_work_item`, `wit_query`, `repo_pull_request`, `repo_file`, `pipelines_build`, `wiki`, `search_code`, `search_workitem`, `core_list_projects`.
- Defence in depth: if `tool_input.action` is present, it must match `get*`, `list*`, `search`, `my`, `download` or `show*`, otherwise deny. This catches a future write action added to a read tool.

**GitHub profile (allowlist).** Allow names starting `get_`, `list_`, `search_`, or ending `_read` (`issue_read`, `pull_request_read`), plus `get_me`. Deny everything else: `create_*`, `update_*`, `merge_*`, `push_*`, `delete_*`, `add_*`, `*_write`, `fork_repository`, `request_copilot_review`, `assign_copilot_*`.

**Bash allowlist.** Tokenise with `shell-quote`. Strip a trailing `2>/dev/null` or `2>&1` first. Pipes are allowed only if every segment is itself allowed. Deny `;`, `&&`, `||`, `&`, any other redirection, `$(`, backticks, `<(`, subshells and `VAR=value` prefixes; the deny message says "read-only mode: run one command at a time; you are already in \<cwd>".

| Command | Allowed forms | Denied |
| --- | --- | --- |
| Shell reads | `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `pwd`, `tree`, `jq`, `stat`, `file`, `du`, `which`, `echo`; `find` without `-exec`, `-execdir`, `-ok`, `-delete`, `-fprint` | Everything else |
| `git` | `status`, `log`, `diff`, `show`, `blame`, `rev-parse`, `ls-files`, `remote -v`, `tag -l`, `branch` with no args or only `-a`, `-r`, `-v`, `--list` | `fetch`, `pull`, `checkout`, `switch`, `commit`, `push`, `reset`, `branch -d/-D/-m`, all others |
| `gh` | `pr view/list/diff/checks/status`, `issue view/list/status`, `repo view/list`, `run view/list`, `workflow view/list`, `release view/list`, `search *`, `label list`, `auth status`; `api` only as GET: no `-X`/`--method` other than GET, no `-f`, `-F`, `--field`, `--raw-field`, `--input`, and never `api graphql` | `pr create/merge/comment/review/checkout/edit`, `issue create/comment/edit/close`, `run rerun/cancel`, `workflow run`, `release create`, all others |
| `az` (DevOps) | `devops project/team/user list/show`, `repos list/show`, `repos pr list/show`, `repos pr reviewer list`, `repos pr work-item list`, `repos ref list`, `boards work-item show`, `boards query`, `boards iteration/area ... list`, `pipelines list/show`, `pipelines runs list/show`, `pipelines build list/show`, `account show` | `rest`, `devops invoke` (arbitrary REST calls), `repos pr create/update/set-vote`, `boards work-item create/update/delete`, `pipelines run`, all others |

```yaml
# ~/.config/agent-chat/readonly.yaml (overrides the built-in defaults)
servers:
  ado: azure-devops        # server name as configured in Claude Code -> profile
  github: github
allow:
  - "mcp__notion__*search*"
deny:
  - "mcp__ado__pipelines_artifact"   # example override
bash:
  extraAllow: ["kubectl get", "kubectl describe"]
```

**Inventory tool.** `npm run gate:inventory -- --dir <path>` spawns Claude in that directory, reads the tool list from the init event, kills the process before any model call, and prints every MCP tool as allow or deny with the rule that decided it. Show the same table on a Settings → Gate page. Run it once for a GitHub repo and once for an ADO repo, and add overrides for anything misclassified.

**UI.** YOLO switch in the composer, sticky per conversation, one click, no dialog. When on, the conversation gets a red border and a "YOLO" label. Routines use `yolo` from their file.

Acceptance:

- [ ] Table-driven classifier tests covering every ADO and GitHub tool name listed above, legacy ADO names, unknown servers, and 40+ Bash cases (including `cd x && ls`, `gh api -X POST`, `gh api graphql`, `find -delete`, `rg foo | head`, `az devops invoke`)
- [ ] Hook test: throwing inside the hook blocks the call; missing `AGENT_MODE` blocks writes
- [ ] Real run: in read-only an agent asked to edit a file is blocked and explains why; flip YOLO, same session, the edit succeeds and the cache hit stays above 80%
- [ ] Real run: agent reads an ADO work item and a GitHub PR in read-only; an attempt to comment on either is blocked

## Phase 5: paragraph threads

Goal: select any text, it snaps to its paragraph, a side thread opens with an agent that has the full prior context, and the main discussion is untouched.

**Blocks.** The frontend runs `marked.lexer(content_md)` and renders each top-level token (skipping `space` tokens) in a `<div data-block="n">`. Messages are immutable once done, so indices are stable. `block_text` stores the raw markdown of that token as a snapshot.

**Starting a thread.**

- Hovering a block shows a thread icon in the left gutter.
- On `mouseup` with a selection, find the nearest `[data-block]` ancestor of the selection start; if the selection spans blocks, use the first. Show a small floating "Thread" button next to the selection.
- Click → `POST /api/threads {message_id, block_index}`, an upsert on the unique key that returns the existing thread if there is one. Threads only on `done` messages.

**Display.**

- A block with a thread gets a left accent bar and a badge (reply count, last activity). Clicking it opens the panel.
- Right-hand panel (about 420 px): the quoted block pinned at the top (collapsible), thread messages, the same composer component. The source block stays highlighted while the panel is open.
- The composer hint defaults to the source message's author agent.
- URL `/c/:conversationId?thread=:threadId` so reload keeps the panel open.
- No thread button inside the panel (one level in v1).

**Backend, first agent turn in a thread.** Phase 3 case 2: resume the agent's parent-thread session with `--fork-session`. Prompt = that agent's unseen parent delta, then the anchor, then the message:

```
<thread_context>
The user opened a side thread on this passage from an earlier message by agent:researcher:
> (block_text)
Focus on this passage. The main discussion continues separately.
</thread_context>

<message from="you">...</message>
```

- Store the new session ID under `(thread, agent, cwd)`. The thread session's delta only ever includes messages from this thread.
- An agent with no parent session gets a seeded session (Phase 3 case 3): parent transcript up to the source message, then the same `<thread_context>` block.
- Thread messages never appear in the main timeline, and the parent session ID is never replaced.

Acceptance:

- [ ] Test: second `POST /api/threads` for the same block returns the same thread
- [ ] Test (fake Claude): first thread turn passes `--resume <parentId> --fork-session`; the next main-timeline turn still resumes `<parentId>`
- [ ] UI: a selection spanning two paragraphs snaps to the first
- [ ] Real run: first thread reply shows a cache hit above 80% and clearly knows the earlier discussion

## Phase 6: directory tagging

Goal: typing `#` offers a fuzzy list of known directories; picking one runs the tagged agents there; free-typed paths are impossible.

**Index (`dirs/scan.ts`).** On startup (and via a "Rescan" button), walk each `dirRoots` entry to `dirScanDepth`, skipping `node_modules`, `.git` internals, hidden folders and anything unreadable. Keep directories that contain `.git`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.sln` or `.claude/`. Merge with channel dirs and `dirs_recent`. Hold the list in memory (a few thousand strings at most).

**Search.** `GET /api/dirs?q=` does fuzzy matching on the path relative to its root, recent directories boosted, top 12 results. Each result shows the folder name large and the full path small, plus a git-branch badge if cheap to read (`.git/HEAD`).

**Composer.** `#` opens the dropdown; arrow keys and Enter insert a chip showing the folder name. One directory chip per message; a second one replaces the first. The "→" hint shows the effective directory ("→ @researcher in main-repo").

**Server.** Accept a `dir` mention only if the path is in the index or the recent list (never a raw path from the client). Record use in `dirs_recent`. A different directory means a different session key, so the agent starts a seeded session there (Phase 3 case 3) and the message shows a "new session in \<dir>" marker.

**Channel settings** reuse the same picker for the channel's default directory.

Acceptance:

- [ ] Test: scan respects depth, skips `node_modules`, detects repos by marker files
- [ ] Test: server rejects a `dir` mention not in the index
- [ ] Real run: `@researcher #other-repo what does this repo do?` runs with cwd `other-repo` and answers about it

## Phase 7: workflows

Goal: tagging `@research-to-brief` runs its steps in order in the current thread, each step visible as a normal agent message, each agent building on the previous step's output.

**Execution.** A workflow is scripted tagging, so it reuses Phase 3 entirely:

1. Create a `runs` row (`kind: workflow`) and post a compact progress card in the thread ("research-to-brief · step 1 of 2 · @researcher").
2. For each step, render the prompt and run it as a turn for that step's agent, in the message's resolved directory and the conversation's YOLO mode. The rendered prompt is stored as a collapsed step message (`author_kind: system`, `author_id: <workflow>`).
3. Later steps see earlier outputs through the normal delta, because they are thread messages.

**Templating.** `{{input}}` = the user's message with the workflow chip removed. `{{prev}}` = the previous step's final text, for prompts that want it inline. No other template features.

**Scope of input.** In a new empty chat the delta is empty, so step 1 gets only the message. In a thread it gets the thread, as with any agent.

**Rules.**

- If a message tags a workflow, only the workflow runs; tagging agents and a workflow together is blocked in the composer with a hint.
- A failed step stops the run; the card shows the error and a "Retry from step N" button.
- Cancel stops the current step and skips the rest.

Acceptance:

- [ ] Test (fake Claude): two-step workflow runs strictly in order; step 2's stdin contains step 1's output inside `<thread_update>`
- [ ] Test: failing step 1 leaves step 2 unstarted; retry resumes at step 1
- [ ] Real run: `@research-to-brief` in an empty chat produces both messages and the card shows done

## Phase 8: routines and scheduler

Goal: when the app starts, each routine whose latest scheduled slot has not succeeded runs exactly once, one at a time, posting into its own channel; failures show an error with a Retry button.

**Slot logic (`scheduler/due.ts`, pure and fully tested).** All times in the system's local time zone.

```ts
lastSlot(schedule, now):
  daily "HH:MM"     -> today at HH:MM; if now < that, yesterday at HH:MM
  weekly "ddd HH:MM" -> this week's ddd at HH:MM; step back 7 days until <= now

isDue(routine, state, now) = state.last_success_slot == null
                           || state.last_success_slot < lastSlot(schedule, now)
```

Opening the app after three days gives one run, because only the latest slot matters. A routine added at 15:00 runs once immediately for today's 07:00 slot.

**Scheduler (`scheduler/scheduler.ts`).**

- Check on startup, then every `routineCheckMinutes` (the app may stay open past 07:00).
- Due routines go into a queue processed by one worker, one routine at a time; each run still goes through the global semaphore.
- Automatic attempts: at most once per slot per server process (in-memory set). A failed slot is not retried by the 10-minute check, only by the Retry button or the next app start.
- On success set `last_success_slot` to the slot; on failure set `last_error` and `last_attempt_at`.

**A run.**

1. Ensure the routine channel exists (`kind: routine`, created from the routine file on first run).
2. Post a run header message in the root thread ("Daily run · Wed 23 Sep").
3. Run the target (agent or workflow) with a fresh session: no `--resume`, and the session cursor starts at the header's `done_seq`, so yesterday's messages are not replayed. The new session replaces the previous one for that key, so chatting in the channel afterwards continues from today's run.
4. On error, the agent message becomes an error card: short reason, stderr excerpt, Retry button (`POST /api/routines/:id/run`).

**UI.** Sidebar Routines section: each routine shows a status dot (ok, running, error) and next slot time. Channel header has "Run now". A manual run that succeeds records the current slot as done.

Acceptance:

- [ ] Tests for `lastSlot` / `isDue`: before and after 07:00, three-day gap, weekly on and off the weekday, both Europe/Madrid DST changes (last Sunday of March and of October)
- [ ] Test: two due routines run sequentially, never in parallel
- [ ] Test: failure → no retry from the periodic check; Retry succeeds and records the slot
- [ ] Real run: change the routine time to five minutes from now with the app open; it fires once and the header plus output appear in the channel

## Phase 9: search and polish

Goal: any past message is two keystrokes away, and the app is pleasant enough to use daily.

**Search.**

- Ctrl+K opens a palette. `GET /api/search?q=` queries `messages_fts` with `snippet()` and `bm25` ranking, 30 results, each showing conversation, thread marker, author and time.
- Filters parsed from the query: `in:#channel`, `from:@agent`, `from:me`.
- Quote user terms before passing them to `MATCH` so FTS syntax characters never cause errors.
- Clicking a result opens the conversation, opens the thread panel if needed, scrolls to the message and flashes it.

**Polish.**

- "Open in terminal" on agent messages copies `cd '<cwd>' && <claudeBin> --resume <sessionId>`. Turns taken in the terminal are part of the session; the app won't display them but the next app turn includes them.
- Keyboard: Enter sends, Shift+Enter adds a newline, Esc closes the panel, Up edits the last unsent draft.
- SSE connection indicator and automatic reconnect; empty states for new channels and chats.
- `README.md`: install, config files, gate inventory, troubleshooting (gateway errors, cache misses, orphan processes).
- Optional `contrib/agent-chat.service` systemd user unit, documented but not installed automatically.

Acceptance:

- [ ] Search finds a word from a thread reply and opens the thread at that message
- [ ] Memory measured and recorded in `NOTES.md`: server idle, and peak with 4 concurrent turns

## Testing and definition of done

Most behaviour is tested without spending tokens; real runs are reserved for the acceptance items marked "real run".

| Layer | Tool | Covers |
| --- | --- | --- |
| Pure logic | Vitest unit tests | `buildArgs`, mention parsing, delta builder, seed truncation, gate classifier, Bash parser, slot logic |
| Server integration | Vitest + fake Claude + temp SQLite | Queue and locks, parallel agents, forks, workflows, routines, auth checks |
| Real runs | Manual, through the wrapper | Streaming, cache hits, gate behaviour with real MCP servers |

Rules for the implementer:

- One commit per phase; `npm run typecheck && npm test` must pass before each commit.
- Real runs use short prompts and the cheapest model alias that works; record cache-hit numbers in `NOTES.md`.
- Never test write actions against real GitHub or Azure DevOps projects; in YOLO checks, use a scratch repo.
- When something in this plan turns out wrong, fix the code, then update `NOTES.md`; do not silently diverge.

**v1 is done when:**

- [ ] All phase acceptance items are checked
- [ ] Idle server stays under 150 MB and no Claude processes remain after runs finish
- [ ] A normal day works end to end: app start runs the 07:00 routine once, two agents discuss in a channel, a paragraph thread forks cleanly, a `#dir` tag switches repos, a workflow runs, search finds it all
- [ ] Follow-up turns in existing sessions consistently show cache hits above 80%
