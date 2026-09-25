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
14. **Built-in `@claude` agent** (added after v1): plain Claude Code with no `--model` and no `--append-system-prompt`, so the CLI's own default model and prompt apply (verified: it ran on `claude-opus-5-5`, the model set in `~/.claude/settings.json`). It is still gated and resumed like any agent. A user `agents/claude.md` replaces it. The app still writes no config files; the agent is defined in `server/config/load.ts`.
15. **Routine freshness** is done by deleting the channel's sessions at the start of a run and, in routine channels, seeding new sessions only from messages after the latest run header. This gives the same result as "no `--resume`, cursor at the header" and also covers every agent in a workflow target.
16. **Thread → channel keeps the thread row.** Turning a side thread into a channel re-parents it (`conversation_id` = the new channel, `parent_thread_id` = NULL, `origin_thread_id` = the old parent) instead of copying messages into a new root. `agent_sessions` is keyed on `thread_id`, so every agent resumes the same Claude session with an unchanged cursor: the next turn sends only the new message (cache hit, no seed, no fork). The new channel's `dir` is the thread's effective cwd, so the `(thread, agent, cwd)` key and the flags hash still match; picking another folder falls back to the move path (fork into the new cwd). `parent_message_id` / `block_*` stay, so the source passage still resolves to the thread (UNIQUE key) and links to the channel.
17. **A block belongs to one thread.** A pick that touches existing threads grows into one thread over all of them (`server/core/passages.ts`); nothing nests. The thread with the most replies keeps its id and sessions; the others' messages and runs move into it and their rows go. Per `(agent, cwd)` one Claude session survives (the kept thread's own, else the newest of a merged one), re-keyed to the kept thread. What that session missed (the wider passage, the other threads' replies) is stored in `agent_sessions.pending` and sent once, ahead of the next message on `--resume`, so the cached prefix still hits; the cursor jumps past everything merged so the delta never repeats it. Merging is refused while a reply is being written, and over a thread that became a channel.
18. **Reset** empties a side thread (messages, runs, sessions) and keeps it on its passage. With no session of its own, its next turn takes the fork path from the main conversation's session again: a cache hit, not a cold seed. **Delete** does the same and removes the thread.

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
| 6 | `@researcher #repo-b what does this repo do?` (browser, `#` dropdown) | ran with cwd `repo-b`, marker "new session in repo-b", answered from its README |
| 7 | `@research-to-brief the history of SQLite` in a new chat (browser) | card "done · 2 steps"; researcher bullets then writer brief built on them; both new sessions (59 % / 58 %, global prefix only) |
| 8 | Routine added at 08:47 with slot 08:49, `routineCheckMinutes: 1`, app open | 08:48 run for the not-yet-succeeded previous slot (as the plan specifies for new routines), then exactly one run at 08:49 for the new slot; header + output in `routine-standup`; no further runs |
| 9 | Search "scans" (a word only in a thread reply) | one result marked "in thread"; Enter opened the conversation with the thread panel and flashed the reply |
| 9 | 4 concurrent turns (two agents in two channels) | all ran at once; 0 `claude` processes left afterwards |
| 2 | Stop during `sleep 40` Bash call | `claude` and the Bash tool's shell (its own process group) both gone 3 s after SIGTERM to the group; message `cancelled` |

## Memory

Measured on macOS (arm64), Node 24, production build (`npm start`):

| State | RSS |
| --- | --- |
| Server idle after startup | 77–84 MB |
| Server during 4 concurrent turns | 85 MB |
| Claude processes during 4 concurrent turns (sum) | 1.15 GB (~285 MB each) |
| Server 5 s after the turns finished | 63 MB; 0 `claude` processes left |

The fifth and later turns queue (`maxConcurrent: 4`).

# Comark rendering (plan `plan/Agent Chat — Comark rendering plan.md`)

## Comark plan changes (findings that override that plan)

1. **The server splits blocks too.** `server/context/blocks.ts` used `marked` to compute `block_text` for new threads, so "server untouched" cannot hold if `marked` is to go. Both sides now call one shared module, `shared/markdown/blocks.ts`, built on the same Comark parser options. `comark` is a runtime dependency of the server.
2. **Comark's parse is async** (`parseMarkdown` returns a Promise). `parseMessage` is therefore `async` and resolves to `null` instead of throwing; `MessageMarkdown` keeps the last good tree while a newer parse is in flight.
3. **No `motion` at runtime, by alias rather than `MotionConfig`.** The vendored components call `useReducedMotion()` from `motion/react`, which reads only the OS setting and ignores `<MotionConfig reducedMotion="always">`. With `MotionConfig` alone, figures still start at `opacity: 0` and wait for `whileInView` (seen in the demo: a full-page screenshot without scrolling shows empty frames). Vite aliases `motion/react` to `web/src/markdown/motion-static.tsx`: `useReducedMotion()` is always `true` and `motion.<tag>` renders the plain tag with the final `animate` / `whileInView` state applied as style. The vendored files stay unedited and `motion` is only a type dependency.
4. **Tokens are scoped to `.md-root`,** not `:root`. The chrome already uses `--border` and `--muted` with other meanings, so the shadcn names are defined on `.md-root` only. The frame corners and `[ TITLE ]` labels paint `bg-background` over the dashed border, so inside messages `--background` is the surface the message sits on (the chrome's `--bg`, or the highlighted block colour), not the demo's page grey.
5. **The chrome's dark mode follows `.dark`** instead of its own `prefers-color-scheme` media query, so the theme toggle switches chrome and messages together. With the default setting (system) the result is identical to before.
6. **Timers:** `graph-timer` / `graph-countdown` tick from one shared 1-second ticker that stops while the tab is hidden (one `// agent-chat:` edit in `graph-clock.ts`). Per-element visibility would need edits in each component.

## Style reference (atinux/comark-graphs-demo @ main, Sep 2026)

Screenshots at 1280 px, light and dark, reduced motion, after scrolling the page so every `whileInView` has fired: `test/visual/reference/{report,catalog,streaming}-{light,dark}.png`. The demo has a dark theme (class `.dark` on `<html>`, stored in `localStorage.theme`, OS preference as fallback).

Values copied from the demo's `src/app/globals.css`:

| Token | Light | Dark |
| --- | --- | --- |
| `--background` | `oklch(0.985 0 0)` | `oklch(0.11 0 0)` |
| `--foreground` (ink) | `oklch(0.205 0 0)` | `oklch(0.86 0 0)` |
| `--border` | `oklch(0.205 0 0 / 0.1)` | `oklch(0.28 0 0)` |
| `--muted` | `oklch(0.96 0 0)` | `oklch(0.18 0 0)` |
| `--muted-foreground` | `oklch(0.5 0 0)` | `oklch(0.62 0 0)` |
| `--ring` | `oklch(0.55 0.16 255)` | `oklch(0.68 0.12 255)` |
| `--graph-accent` | `oklch(0.5 0.14 228)` | `oklch(0.77 0.15 228)` |
| `--graph-accent-2` | `oklch(0.48 0.18 259)` | `oklch(0.68 0.18 259)` |
| `--graph-accent-3` | `oklch(0.5 0.14 248)` | `oklch(0.72 0.15 248)` |
| `--graph-frame` (dashed lines) | `oklch(0.205 0 0 / 0.28)` | `oklch(0.48 0 0)` |
| `--graph-muted` | `oklch(0.52 0 0)` | `oklch(0.52 0 0)` |
| `--graph-faint` | `oklch(0.82 0 0)` | `oklch(0.28 0 0)` |
| `--contrast-14/23/45/70` | `0.88 / 0.76 / 0.48 / 0.28` (grey L) | `0.22 / 0.34 / 0.62 / 0.84` |

The demo's accents are three blues (228, 259, 248 hue). mdxcn's own defaults are blue / amber / jade (`oklch(0.5 0.18 255)`, `oklch(0.58 0.14 70)`, `oklch(0.5 0.12 165)`); the demo's values win.

- **Fonts:** Geist (sans, body) and Geist Mono (figures, headings, code) with `font-feature-settings: "ss01" 1, "zero" 1` on mono. Antialiased.
- **Dashed lines:** `repeating-linear-gradient(<dir>, var(--graph-frame) 0 2px, transparent 2px 7px)`, 1 px thick (`graph-frame`, `graph-rule`, `graph-rule-y` utilities). `graph-scroll-x` scrolls with hidden scrollbars.
- **Page:** `max-w-4xl` (56rem) column, `px-5 sm:px-8`; prose paragraphs and lists `max-w-[68ch]`.
- **Prose (`comark-prose`),** every rule guarded with `:not(figure *)`: blocks `margin-top: 1.5rem`; `h1` mono `text-2xl sm:text-3xl` leading-tight tracking-tight; `h2` mono `text-base` uppercase `tracking-[0.08em]` `mt-16`; `h3` mono `text-base` tracking-tight `mt-10`; `p, li` `0.95rem` leading-relaxed; `ul` no bullets, `li::before` `-` in accent with `mr-2`, `space-y-2`; `ol` decimal `pl-5`; `a` accent, dotted underline, offset 4px; `strong` medium weight; inline `code` `bg-muted` mono `0.85em`, padding `0.1em 0.35em`; `pre` dashed frame, `p-5`, mono `text-xs`; `blockquote` accent left border 1 px, `pl-4`, italic, muted; `hr` dashed rule `my-12`; `figure` `my-12`. Selection: accent background, `--background` text.
- **Code:** the demo has no Shiki theme (plain `pre`), so Phase 4 uses `github-light` / `github-dark`.
- **Tabs / chrome style:** mono `text-xs` uppercase, active tab `[ LABEL ]` in accent, inactive in `--graph-muted`.

## Component source

- markdown-graphs is now **mdxcn** (`https://mdxcn.dev/r/all.json`, repo `keshav-exe/mdxcn` at `2928126`, 19 Sep 2026). Its registry is a superset of the demo's copy: the same 32 `graph-*` components, each also accepting children (`<Row>`, `<Head>`…) besides data props, plus content components (callout, quote, steps, terminal, changelog), Knap filters, and **`graph-comark`**.
- `graph-comark` covers everything the demo's `coerce.ts` and adapter do: numbers, booleans, `:`-prefixed keys, `class` → `className`, `$` meta dropped, an empty `[ TITLE ]` frame (`· · ·`) while required props are missing, and a remount key on data change. Its tag list and `required` / `numeric` hints are identical to the demo's. Nothing needs porting.
- Decision: vendor mdxcn's `graph-frame`, the 32 `graph-*` components and `graph-comark` (not content components, not Knap). Data-form output was checked against the demo screenshots in Phase 5; no component needed the demo's copy.
- mdxcn's `row` collapses with `sm:` viewport breakpoints; the app registers its own `row` with a container query (Phase 5).

## Comark API (comark / @comark/react 0.7.0)

- Parse: `createMarkdownParser(options)` → `async (md) => MarkdownDocument` (`{ nodes, frontmatter, meta }`); `parseMarkdown(md, options)` is the one-shot form. Nodes are `['tag', attrs, ...children]` tuples, text is a string, comments are `[null, attrs, text]`.
- Render: `MarkdownDocument` from `@comark/react` takes `value` (`{ nodes }` is enough, so **a subset of top-level nodes renders fine**: one block at a time), `components`, `streaming`, `caret`. It wraps the output in `<div class="comark-content">`.
- Overrides: `components[tag]` (also tried as `ProseTag` / `Tag`) replaces native tags (`p`, `a`, `table`, `pre`…) as well as `::tags`. Children of `pre` are never resolved to components. An `as` attribute can redirect a node to another mapped component (the sanitiser removes it).
- Serialise one node: `renderMarkdown({ nodes: [node] }, { blockAttributesStyle: 'frontmatter' })` from `comark/render`. Round-trip (parse → render → parse) is exact for prose, lists, fences, tables, `::graph-*` with YAML props and nested `::row`. Prose is re-escaped (`[js](javascript:…)` comes back as `\[js\](…)`).
- Raw HTML: on by default (the `html` plugin, marked `$.html = 1`). **Disabled** with `registerDefaultPlugins: false` and an explicit plugin list (`task-list`, `components`, `attributes`); HTML then stays literal text. The `frontmatter` plugin is also left out, so a message starting with `---` is an `hr` as in CommonMark, and `alert` is left out so `> [!NOTE]` stays a quote.
- `javascript:` links are not linked by the tokenizer (markdown-it's `validateLink`); the sanitiser still checks every `href` / `src`.
- Unknown `::tag`: rendered as a DOM element with that tag name (`<unknown-thing a="1">`), so the sanitiser must replace it.
- `style` strings become React style objects, `class` becomes `className`; any other attribute (`onclick`…) passes through as a prop. GFM table alignment arrives as `style="text-align:…"` on `th` / `td`, so the sanitiser turns it into an `align` prop before dropping `style`.
- Task lists: `ul.contains-task-list > li.task-list-item > input[type=checkbox][:checked]`.
- Streaming: auto-close is on by default. Reproduced the partial-YAML throw: for a 114-character `::graph-table` block, 42 prefixes throw `YAMLException` (`expected ':' after a mapping key`, `bad indentation`, `unexpected end of the stream within a double quoted scalar`). Also seen: a prefix ending in a bare word (`title`) parses as a YAML string that gets **spread into numeric keys** (`{"0":"t","1":"i",…}`); the sanitiser drops numeric keys.
- Comark's React `Mermaid` component uses `beautiful-mermaid` (not `mermaid`), is not lazy and uses its own themes, so the app's own `MermaidBlock` is used (Phase 6). Its Shiki plugin highlights at parse time, so highlighting moves into the `pre` component (Phase 4).

Pinned: `comark` 0.7.0, `@comark/react` 0.7.0, `tailwindcss` / `@tailwindcss/vite` 4.3.3, `motion` 13.4.2 (types only), `clsx` 2.1.1, `tailwind-merge` 3.7.0, `shiki` 4.4.3, `mermaid` 12.0.0, `@fontsource-variable/geist` and `geist-mono` 5.3.0, `@playwright/test` 1.63.0 (matches the cached Chromium 1243).

### Phase 2 findings

- **`block_text` is the block's own source lines**, not Comark's serialisation. Comark 0.7.0's `renderMarkdown` drops text in one case found by the round-trip test (a task item followed by a nested list: `- [ ] b\n  - nested` comes back as `- [ ] - nested`). A small parser plugin records each top-level token's line range; `blocksOf` slices those lines (plus the closing `::` of a component, which the range leaves out), re-parses the slice and uses it only if it yields the same node, else falls back to `renderMarkdown`.
- **Heading ids are off** (`headingIds: false`): they depend on the rest of the document (`foo`, `foo-1`), which broke the per-block round trip, and content must not set DOM ids.
- **First paint:** Comark's parse resolves within microtasks (report.md, 6 KB: ~0.5 ms in Node), so `MessageMarkdown` parses in a layout effect and commits with `flushSync` before the browser paints. Historical messages never flash unrendered text.
- **Streaming caret** is CSS only: `::after` on the last text element of the last block. Comark's own `caret` option mutates the tree it is given (it pushes a node into the last element), which would corrupt cached trees.
- **Migration on a copy of the real database** (`~/.local/share/agent-chat/agent-chat.db`, backed up with SQLite's backup API): 1 thread, 0 re-anchored, 1 unchanged, 0 unmatched; a second run reports "already migrated".

### Phase 3 findings

- **Prose matches the demo's computed styles** for body text, links, inline code and `h2` in light and dark (`test/visual/prose.spec.ts` compares against `test/visual/reference/prose-styles.json`, measured from the running demo; colours compared as rendered RGBA since Tailwind emits `oklch()` and the demo's build emits `lab()`).
- Chat adjustments to the demo's document spacing: block gap 1rem (1.5rem around figures, 2rem before `h2`), headings one step smaller (h1 20/24 px, h2 and h3 14 px). List dashes stay in the accent colour as in the demo; ordered-list numbers are muted.
- A paragraph that holds only an image becomes a framed figure (alt text as title), because a `<figure>` cannot sit inside a `<p>`. Inline images stay inline.
- Plain GFM tables reuse `::graph-table`'s markup inside the shared `Graph` frame, but keep inline markdown in cells and wrap long text cells (graph tables never wrap). mdxcn's own `tableOf()` would have flattened cells to strings.
- Frame corners (`+`) sit centred on the frame edge, 8 px outside it, as in the demo; the width check allows for that.
- The style lab is a lazy chunk at `/dev/markdown` (not linked from the UI) so the production build used by Playwright has it; fixtures are bundled from `test/fixtures/markdown/` at build time.

### Phase 4 findings

- Shiki is created from `shiki/core` with the JavaScript regex engine; grammars come from `shiki/langs`' `bundledLanguages` map (346 ids including aliases such as `ts`, `sh`, `yml`), each a separate chunk. The map, Shiki and the two themes (`github-light` / `github-dark`; the demo has no code theme) form one lazy chunk (`shiki-*.js`, 64 KB gzipped) loaded on the first fenced block with a language. Checked by `test/visual/code.spec.ts`: a message with two TypeScript blocks requests exactly one grammar chunk.
- `codeToHtml(..., { structure: 'inline', defaultColor: false })` gives spans carrying `--shiki-light` / `--shiki-dark`; `.dark` picks the set in CSS. The output goes inside the app's own `<pre><code>` in the dashed frame (`[ TS ]` label, `copy` button, `+` corners).
- "Fence closed" is approximated per block: the last block of a streaming message is treated as open (`BlockContext`), so it stays plain until another block follows or the message finishes.

### Phase 5 findings

- **All 32 mdxcn graphs plus `row` render from the demo's report and catalog** and match the demo's own figures: each figure is compared with a crop of the demo (`test/visual/figures.spec.ts`, baselines captured from the running demo at 832 px, 3 % pixel tolerance for font rasterisation; `geist` in the demo vs `@fontsource-variable` here). mdxcn's copies (newer than the demo's) were kept for every component.
- **One intended difference: `graph-cells`.** Its body is `@container … @min-[28rem]:flex-row`: the query targets the nearest *ancestor* container. The demo has none, so its shards stack vertically; here the message column is a container (plan step 6), so they sit in a row as mdxcn intends. That figure is left out of the demo comparison.
- **Static motion needs variant inheritance.** Children such as a funnel's rows carry `variants` but no target and inherit the parent's `whileInView="show"`; without that, a `style={{ opacity: 0.4 }}` dim meant to be overridden by the animation stayed on (seen as greyed rows). `motion-static.tsx` passes the active labels down through context, and the animation target wins over the static style.
- **Streaming figures:** half-written YAML rows make some graphs throw (heatmap, flow), and a prefix can parse with props on one frame and without on the next. Three measures: the last block of a streaming message keeps its last good render (or an empty frame) when it throws instead of showing the error frame; a figure whose props shrink between frames keeps the previous node (`holdFigureProps`); and the empty frame is compact (`py-5` instead of `py-14`, one `// agent-chat:` edit), so a figure only grows as its props land. Streaming `report.md` at 8 characters per frame: no block moves and the message never shrinks by more than a line (`test/visual/streaming.spec.ts`).
- **Caught errors are logged as debug.** React 19 reports errors caught by an error boundary with `console.error`; `createRoot`'s `onCaughtError` sends those from `BlockBoundary` to `console.debug`.
- The pending frame is not the figure's final size (unknowable before its props arrive); keeping it smaller than every figure avoids the shrink that would otherwise be the jump.

### Phase 6 findings

- Comark's Mermaid plugin was not used: its React component renders with `beautiful-mermaid`, eagerly, with its own themes. `MermaidBlock` is a `React.lazy` chunk (6 KB) that imports `mermaid` 12 on first use (`mermaid.core` 29 KB gzipped plus per-diagram chunks).
- **Mermaid cannot read `oklch()`** (its colour maths uses khroma), so theme variables are resolved from the tokens to `#rrggbb` through a canvas at render time. Mermaid 12 draws node shadows by default; `themeVariables.dropShadow: 'none'` turns them off. Sequence diagrams have their own font sizes (16 px by default), set to 13 px.
- Renders are queued, one at a time, because each re-initialises Mermaid with the theme of its own frame. SVGs are cached by (source hash, theme); switching theme renders again from the cache key.
- **Content cannot configure Mermaid:** `%%{init}%%` directives and front-matter `config:` are stripped before rendering (only `title:` is read, for the frame), and `secure` lists the theme and security keys as well. This closes `themeCSS` injection into the SVG's `<style>`.
- `suppressErrorRendering: true` plus a `parse()` before `render()` keeps Mermaid's error graphic out of the page; the frame shows the source and the first line of the error.

### Phase 7 findings

- The catalog (`server/prompts/comark-graphs.md`) is 7.2 KB, about 2,400 tokens at a pessimistic 3 characters per token; the test bounds it at 12,000 characters (4,000 tokens). Every example in it parses and renders without an empty or fallback frame (tested). mdxcn's own Comark examples were compacted to flow-style YAML; two of them are invalid YAML upstream (`graph-diff` and `graph-invoice` put a mapping on the key's line: `footer:   label: shipped`).
- The fake Claude's session list is not safe for two new sessions started at the same instant (one resume then fails as "missing"); tests that count calls per agent post one agent per turn. The pre-existing `context.test.ts` "reverse order" check (processes started < 400 ms apart) is timing-sensitive and failed once in ~10 full runs under load.
- **Real runs** (`claude -p --model sonnet`, Claude Code 2.1.281, same `--append-system-prompt` as the runner builds: agent body + catalog; tools disabled). Replies saved as `test/fixtures/markdown/realrun-*.md` and checked by `test/visual/realrun.spec.ts`:
  - five PRs by size and review time: prose, one `::graph-table` (with a derived "h per 100 lines" column), prose, and a caveat about the small sample. Renders with no fallback frame.
  - login sequence with the token exchange: a Mermaid `sequenceDiagram` with a front-matter title; renders.
  - three-step deploy: `::graph-flow` with three nodes, then a numbered list. (It opened with the figure rather than prose.)

### Phase 8: dark mode, search snippets, performance

**Dark mode.** The demo has a dark theme, so its values are used unchanged (table above). Contrast of text against the surface it sits on (`test/visual/contrast.spec.ts`), WCAG ratio:

| Text | Light, message | Light, demo page | Dark, message | Dark, demo page |
| --- | --- | --- | --- | --- |
| ink `--foreground` | 17.93 | 17.18 | 11.71 | 13.43 |
| accent `--graph-accent` | 5.48 | 5.25 | 8.88 | 10.18 |
| `--muted-foreground` | 6.01 | 5.76 | 4.91 | 5.63 |
| `--graph-muted` (figure labels, captions) | 5.49 | 5.26 | **3.26** | **3.73** |

Accent text passes AA everywhere. The demo's dark `--graph-muted` (`oklch(0.52 0 0)`, the same as in light) does not reach 4.5:1 on a dark surface; it was kept to stay identical to the demo. Raising it to about `oklch(0.62 0 0)` would pass, at the cost of the dark figure comparison. Shiki uses `github-dark`; Mermaid takes its colours from the same tokens, so both follow the theme. Every fixture has a dark snapshot in the style lab tests.

**Search snippets.** FTS still indexes raw `content_md`; the palette runs `cleanSnippet()` (`web/src/lib/snippet.ts`) on each snippet: `::graph-*` lines become `[figure: graph-table · Title]` (the title from the attribute or a later `title:` line), `---` and closing `::` lines are dropped, YAML data loses its punctuation (`- ["/docs", "121 kB"]` → `/docs, 121 kB`), and a Mermaid fence becomes `[diagram]`. FTS's 14-token window often starts inside a props block; that case is detected (the first `---` is followed by the closing `::`).

**Performance** (MacBook, Chromium 153 headless, production build, `npm run test:perf`):

| Measure | Budget | Result |
| --- | --- | --- |
| Initial JS added by Phases 1–7, gzipped | ≤ 250 KB | **+65 KB** (index chunk 160.2 → 225.3 KB). This is net of removing marked, DOMPurify and highlight.js. Shiki (64 KB), each grammar, Mermaid (29 KB core plus per-diagram chunks), the style lab and the catalog prompt are separate lazy chunks. `ANALYZE=1 npm run build` writes `web/dist/stats.html`. |
| Open a channel with 200 messages including 40 figures | < 300 ms | **~160 ms** cold, from the thread response to every message body rendered; ~29 ms when re-opened (parse LRU hit) |
| Parse per streamed frame, ~5,000 characters | < 8 ms | median **0.30 ms**, p95 0.50 ms, max 2.3 ms (parse + sanitise) |
| Scroll through 500 messages | no long tasks > 50 ms | **none** (97,928 px scrolled in 400 px steps, one per frame) |

No Web Worker and no offscreen deferral were needed.

# Shared Markdown documents

- **A document is a user message with `meta.kind: 'document'`** (`server/context/documents.ts`), posted by `POST /api/threads/:id/documents` (main threads only, `.md`/`.markdown`, ≤ 2 M characters). No agent answers it; it takes paragraph threads like any reply. `DocumentMessage` renders it in the timeline.
- **Context.** Deltas and seeds carry a document whole (`renderDocument` is a pure function of name and text, so the bytes are identical in every prompt); seeds put documents first, outside the history limits. From `READER_MIN_CHARS` (20 k) a document's first thread per `(agent, cwd)` runs a short reader turn that reads it once; later threads fork that reader session, so the document is a cache read, not a new cache write per thread (`document_sessions`, migration 006).
- **Rendering.** The document is parsed once (the `useParsed` LRU) and split into ~5 k-character chunks (`chunkBlocks`); only chunks within 1.5 screens of the viewport are in the DOM, the rest are placeholders of their measured (or estimated) height. A 50 k-word document (~100 pages, 265 KB) in a 13-message channel, production build, headless Chromium at 1400×900: at most 4 chunks / 47 blocks in the DOM; scrolling all 128 k px in 400 px steps, one per frame, down and back up: **no long tasks, no position drift** (browser scroll anchoring absorbs placeholder → measured height changes).
- Jumps (contents, threads, previous / next) render the target chunk first, then scroll; a jump over 1.5 screens lands instantly with a short cross-blur instead of a long smooth scroll, then holds the target in place for a few frames while neighbouring chunks resize.
