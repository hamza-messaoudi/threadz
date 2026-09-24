# Agent Chat

A local, single-user, Slack-like web app for chatting with Claude Code agents. It has channels, ad-hoc chats, `@`-tagged agents and workflows, paragraph threads, `#directory` tagging, and daily or weekly routines.

All model work is done by headless Claude Code (`claude -p`). The app starts one process per turn, streams its output into the UI and resumes the same Claude session on the next turn, so follow-up turns are almost entirely cache reads. It never calls the Anthropic API itself.

## Install

Requires Node 22 or later and a working `claude` CLI (or your gateway wrapper around it).

```sh
npm install
npm run build
npm start
```

The server prints a login link such as `http://127.0.0.1:4777/?t=…`. Open it once; the token moves into a cookie. The token is stored in `~/.local/share/agent-chat/token`, so the link stays the same across restarts.

Only one instance runs per port. If Agent Chat is already running, `npm start` prints its link and exits instead of crashing. To restart it with a fresh build, run `npm start -- --replace` (or set `AGENT_CHAT_REPLACE=1`). This stops the old instance gracefully, which cancels its running turns, and then starts. If a different program holds the port, the app says so and exits; change `port` in `config.yaml`.

For development, `npm run dev` runs the server with `tsx watch` and the Vite dev server on port 5173 (use the `dev UI` link it prints).

Other scripts: `npm test` (Vitest with a fake `claude`, no tokens spent), `npm run typecheck`, `npm run gate:inventory -- --dir <path>`.

## Config files

Everything lives in `~/.config/agent-chat/` and reloads when you save. The app never writes these files. An invalid file is skipped and shown in a "Config problems" banner.

```yaml
# config.yaml (all keys optional)
claudeBin: ~/bin/claude-gw        # your wrapper; defaults to "claude"
port: 4777
maxConcurrent: 4                  # turns running at once; extra ones queue
defaultModel: sonnet
scratchDir: ~/.local/share/agent-chat/scratch
dirRoots: [~/code, ~/work]        # scanned for #dir autocomplete
dirScanDepth: 2
routineCheckMinutes: 10
```

Agents use the Claude Code agent format, one file each in `agents/`:

```markdown
---
name: researcher
description: Digs into topics and cites sources
model: sonnet
tools: [Read, Grep, WebSearch, "mcp__ado__*"]   # optional, enforced by the gate in every mode
---
You are a research agent...
```

There is also a built-in agent, `@claude`, that needs no file. It is plain Claude Code: it runs without `--model` or `--append-system-prompt`, so it uses the model from your own Claude Code settings plus your usual `CLAUDE.md`, skills and MCP servers. It still goes through the read-only gate until you switch YOLO on. To change it, create `agents/claude.md`, which replaces the built-in agent.

Workflows in `workflows/*.yaml` run their steps in order in the current thread. `{{input}}` is your message without the workflow tag and `{{prev}}` is the previous step's reply:

```yaml
name: research-to-brief
description: Research a topic, then write a one-page brief
steps:
  - agent: researcher
    prompt: "Research this: {{input}}"
  - agent: writer
    prompt: "Turn the research above into a one-page brief."
```

Routines in `routines/*.yaml` run once per scheduled slot, one at a time, and post into their own channel:

```yaml
name: ado-standup
schedule: { daily: "07:00" }      # or { weekly: "mon 07:00" }
channel: routine-ado-standup
target: agent:researcher          # or workflow:research-to-brief
dir: ~/work/main-repo             # optional; default scratchDir
yolo: false
prompt: "Summarise my active ADO work items and PRs needing review."
```

When the app starts it runs each routine whose latest slot has not succeeded yet, once, even if several days were missed. A routine added after today's time runs once straight away for that slot. Failed runs are retried only by the Retry button or the next app start.

Agent and workflow names share one `@` namespace, so they must be unique.

## Using it

- `@agent` tags run in parallel. An untagged message goes to the last agent that replied in the thread; the hint under the composer shows where it will go.
- `#dir` picks a directory from the index (`dirRoots` plus channel and recent directories). Free-typed paths are not accepted.
- To start a new project, type a folder name that doesn't exist yet after `#`, or in a channel's directory picker. The first choice is then **＋ New folder "name"**, which creates the folder inside your first `dirRoots` entry, runs `git init` and selects it. The New channel dialog also offers **Start a new project folder** named after the channel. Folders can only be created inside `dirRoots`, and names are limited to letters, digits, `.`, `-` and `_`.
- Select text in any finished message and click **Thread** to open a side thread on that paragraph. The agent's session is forked, so it knows the earlier discussion, and the main timeline is not affected.
- **YOLO** (composer switch) lets agents change files and run write actions in that conversation. It is off by default.
- Ctrl+K / ⌘K searches every message. You can add filters: `in:#channel`, `from:@agent`, `from:me`.
- **Open in terminal** on an agent message copies `cd '<cwd>' && <claudeBin> --resume <session>`. Turns you take in the terminal become part of the session, so the next app turn includes them.
- Keyboard: Enter sends, Shift+Enter adds a new line, Esc closes the thread panel, Up in an empty composer brings back your last message.

## Read-only gate

Every turn runs with `--permission-mode bypassPermissions` plus a PreToolUse hook (`dist/hook.mjs`) registered through `--settings`. The hook reads `AGENT_MODE` from the environment, so switching YOLO on or off never changes the command-line flags and never breaks the cache.

In read-only mode:

- Read tools are allowed (`Read`, `WebSearch`, `WebFetch`, subagents and others). `Write`, `Edit` and any unknown built-in are blocked.
- Bash is limited to read commands: `ls`, `cat`, `rg` and similar, read-only `git`, `gh` and `az devops` subcommands, and pipes made only of those. `&&`, `;`, redirection and `$(…)` are blocked.
- GitHub and Azure DevOps MCP tools are allowed only when they read. Their profiles are detected from the server name. Tools from other MCP servers are blocked unless you allow them.
- Any error inside the hook blocks the call.

Blocked calls show as 🔒 chips on the message, and every decision is logged to `~/.local/share/agent-chat/hook.log`.

Overrides go in `~/.config/agent-chat/readonly.yaml`:

```yaml
servers:
  ado: azure-devops        # MCP server name -> profile (github | azure-devops | none)
  github: github
allow:
  - "mcp__notion__*search*"
deny:
  - "mcp__ado__pipelines_artifact"
bash:
  extraAllow: ["kubectl get", "kubectl describe"]
```

### Gate inventory

Run the inventory once in each repo that has MCP servers. It lists every tool and shows whether read-only mode allows it:

```sh
npm run gate:inventory -- --dir ~/work/main-repo
```

The same table is under **Settings → Read-only gate** in the app. The inventory starts Claude and stops it as soon as the tool list arrives, so at most one tiny model call starts. Add an override for anything that is classified wrong.

## Troubleshooting

- **Gateway errors.** The message turns into an error card with the last 4 KB of the CLI's stderr. Run the same command in a terminal (`<claudeBin> -p --output-format stream-json --verbose`) to check the wrapper. The wrapper must keep stdout as clean JSON lines and pass the exit code through.
- **Cache misses.** Each agent message has a cache badge. It shows the share of the turn's first API call that was read from cache, and the tooltip has the raw token counts. A new session starts at about 45–60 %, because only Claude Code's shared prefix is cached. Follow-up turns should be above 90 %. Two things start a new session on purpose: a changed agent file, and a different directory. The message then shows a "new session" marker. `--resume` ignores a changed `--append-system-prompt`, so the app re-seeds the session instead.
- **Orphan processes.** Each turn runs in its own process group, and Stop kills the whole group. To check, run `pgrep -fl "claude -p"`: nothing should be listed when no turn is running. When the server shuts down it cancels running turns. Turns that were running during a crash are marked "interrupted" on the next start.
- **A project disables hooks.** A project's `disableAllHooks: true` cannot switch off the gate, because the app's `--settings` file sets it back to `false`.
- **Nothing in `#` autocomplete.** Set `dirRoots` and click **Rescan directories** in Settings. The index only includes folders that contain `.git`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.sln` or `.claude/`.

## Running as a service

`contrib/agent-chat.service` is a systemd user unit. It is not installed automatically; the comments at the top of the file explain how to install it.

## Message rendering

Messages are Markdown rendered with [Comark](https://comark.dev), so agents can also write figures (`::graph-table`, `::graph-plot`…) and Mermaid diagrams. Raw HTML is shown as text, and only known tags render. Open `/dev/markdown` for the style lab, which renders the fixtures in `test/fixtures/markdown/`. `npm run test:visual` runs the Playwright checks against it.

If you upgrade from a version that used `marked`, run `npm run migrate:blocks` once with the app stopped. It re-anchors existing paragraph threads to the new block split.

## Credits

- [Comark](https://github.com/comarkdown/comark), MIT.
- [mdxcn](https://github.com/keshav-exe/mdxcn) (formerly markdown-graphs) by Keshav Bagaade, MIT. The figure components in `web/src/registry/default/` are copied from its registry, with its licence in `web/src/registry/default/LICENSE`.
- The visual style and the report and catalog fixtures come from [atinux/comark-graphs-demo](https://github.com/atinux/comark-graphs-demo).

## Layout

```
server/   Hono API + SSE, SQLite (better-sqlite3, FTS5), runner, gate, scheduler, directory index
web/      Vite + React UI
test/     Vitest suites, fake-claude.mjs, recorded stream fixtures
NOTES.md  Phase 0 CLI findings, plan changes, cache and memory measurements
```
