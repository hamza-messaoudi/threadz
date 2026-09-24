# Agent Chat — Comark rendering plan

Sep 24, 2026 · @sedik

## Scope and decisions

Replace the message renderer with Comark, styled exactly like [atinux/comark-graphs-demo](https://github.com/atinux/comark-graphs-demo), with every markdown-graphs component and Mermaid available to agents that opt in. Build in phases 0 to 8, one commit per phase, same rules as the main plan (`typecheck` and tests pass before each commit; `NOTES.md` records findings that change this plan).

| Decision | Choice |
| --- | --- |
| Styling scope | Message content now (prose, tables, code, charts, Mermaid). App chrome later, but tokens are defined so it can adopt them without rework |
| Components | All markdown-graphs components, plus the demo's `::row` layout |
| Plain markdown | Same visual style applies to every message, with or without components |
| CSS | Tailwind v4 via `@tailwindcss/vite`, components copied as-is |
| Animation | None: no `motion` at runtime, figures render in their final state |
| Themes | Light and dark |
| Code | Shiki replaces highlight.js |
| Diagrams | Mermaid via ```` ```mermaid ```` fences |
| Teaching agents | Opt-in per agent with `render: graphs` in frontmatter |

### Ground rules

1. **No MDX, no evaluation.** Only tags in the component map render; anything else renders as a neutral frame showing the block's source. Props are data, never code.
2. **Server untouched** apart from one agent-config key and the prompt text it adds (Phase 7). Messages stay stored as raw text in `content_md`; old messages render unchanged because Comark is a superset of CommonMark and GFM.
3. **Heavy things load lazily.** Mermaid and Shiki grammars are dynamic imports, fetched only when a message needs them. The initial bundle must not grow by more than 250 KB gzipped (measured in Phase 8).
4. **Streaming never breaks the view.** A parse error keeps the last good render; a component missing required props shows an empty frame of its final size.
5. **Licences travel.** Copied components keep their MIT licence file and a credits line in the README.

## Phase 0: study the reference and pin versions

Output: a "Style reference" and a "Comark API" section in `NOTES.md`, reference screenshots in `test/visual/reference/`, and pinned versions in `package.json`. No app code changes.

**Background.** The demo uses no MDX. Its figures are Comark blocks resolved to React components copied from markdown-graphs. That library has since been renamed **mdxcn** ([repo](https://github.com/keshav-exe/mdxcn), site `mdxcn.dev`). It lists 32 components plus shared frame primitives, and now ships its own Comark adapter: `graphComponents` from `graph-comark.tsx`, or `createGraphComponents` for a subset. It requires a shadcn-style project and `motion`. Its design: Geist Mono, dashed frame with `+` corners, title as `[ TITLE ]`, one accent `--graph-accent` with optional `--graph-accent-2` / `--graph-accent-3`, glyphs instead of SVG, and motion that goes to zero duration under `prefers-reduced-motion`.

1. **Run the demo.** Clone [atinux/comark-graphs-demo](https://github.com/atinux/comark-graphs-demo) outside the repo, `npm install && npm run dev`. With Playwright, screenshot `/`, `/catalog` and `/streaming` at 1280 px, in light and (if the demo has one) dark. These screenshots are the visual source of truth for every later phase.
2. **Extract the style.** From the demo's global CSS and page layout, record exact values: background, ink, muted grey, border and dashed-line colours, `--graph-accent*` values (the blue and jade), fonts and sizes, prose spacing, max content width, heading/list/table/blockquote/code treatments, and the Shiki theme if any. Copy values; never approximate from screenshots.
3. **Choose the component source.** Diff the demo's `src/registry/default/` against the current mdxcn registry (`https://mdxcn.dev/r/all.json`). Default to the latest mdxcn with its `graph-comark` adapter. For any component where the rendered output differs from the demo screenshots, keep the demo's copy. Also note whether `graph-comark` already covers what the demo's `coerce.ts` does (numbers, booleans, `:`-prefixed keys, `class` → `className`) and empty frames for missing required props; if not, port those from the demo.
4. **Verify Comark behaviour** against the pinned version and record answers:
   - exact parse export (`parseMarkdown` or `parse`) and the tree renderer the demo uses (`MarkdownDocument`)
   - can the renderer take a subset of top-level nodes (needed for paragraph blocks)?
   - how native tags (`p`, `a`, `table`, `pre`...) are overridden via `components`
   - single-node serialisation back to markdown (`renderMarkdown` or equivalent)
   - raw HTML handling: is it passed through, and can it be disabled?
   - what an unknown `::tag` renders as
   - reproduce the partial-YAML parse throw on a streamed prefix
5. **Pin versions:** `comark`, `@comark/react`, `tailwindcss`, `@tailwindcss/vite`, `motion`, `clsx`, `tailwind-merge`, `shiki`, `mermaid`, `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` (the demo's `geist` package is Next.js-specific).

## Phase 1: Tailwind v4, tokens and themes

Goal: Tailwind and the demo's tokens are available inside messages, with a working light/dark switch, and the existing app chrome looks exactly as before.

1. **Tailwind via Vite.** Add `@tailwindcss/vite` to `vite.config.ts`. Create `web/src/styles/markdown.css` importing `tailwindcss/theme` and `tailwindcss/utilities` only, **without Preflight**. Preflight would restyle the plain-CSS chrome; it gets enabled when the chrome migrates later. Add `@source` lines for `web/src/registry/**` and `web/src/markdown/**`.
2. **Scoped reset.** Everything rendered from markdown sits inside `.md-root`. Give it a small reset (box-sizing, margins, list styles, table collapse) so components look as they would with Preflight.
3. **shadcn conventions the copied components expect:** `@/` alias in `vite.config.ts` and `tsconfig.json`, `web/src/lib/utils.ts` exporting `cn()` (clsx + tailwind-merge), and a `components.json` so `shadcn add` can install registry items.
4. **Tokens.** One file, `web/src/styles/tokens.css`, holding every colour and font from the Phase 0 style reference as CSS variables: shadcn names (`--background`, `--foreground`, `--muted-foreground`, `--border`...) plus `--graph-accent`, `--graph-accent-2`, `--graph-accent-3`, and a dashed-line colour. Map them into Tailwind with `@theme inline`. Light values on `:root`, dark values on `.dark`.
5. **Theme switch.** Tailwind variant `@custom-variant dark (&:where(.dark, .dark *));`. A `useTheme` hook sets `.dark` on `<html>` from a setting (light, dark or system, default system) stored in `localStorage`, following `prefers-color-scheme` when set to system. Add a small toggle to the existing settings panel.
6. **Fonts.** Self-host Geist and Geist Mono via `@fontsource-variable` packages (no network fetches), applied inside `.md-root` only for now.

Acceptance:

- [ ] Screenshot of the app chrome before and after this phase is pixel-identical (Playwright diff)
- [ ] A test element using `text-[var(--graph-accent)]` and `dark:` classes switches colour with the toggle
- [ ] `npm run build` output contains only utilities actually used

## Phase 2: swap marked for Comark

Goal: every message renders through Comark, paragraph threads still work, streaming never flashes broken output, and `marked`, DOMPurify and highlight.js are gone from the bundle.

Comark supports this directly: auto-close completes unterminated syntax (bold, open code fences, half-open components), and it can parse separately from rendering, producing a serialisable document of `['tag', props, ...children]` tuples ([source](https://comark.dev/rendering/react)). The app does its own parse so it controls blocks, caching and the last-good tree, then hands the tree to Comark's React renderer.

```
web/src/markdown/
  parse.ts            parseMessage(md) -> { tree, blocks } | null (never throws)
  sanitize.ts         tree pass: allowlists, unknown tags, URLs, classes
  blocks.ts           top-level nodes -> Block { index, node, source }
  components.tsx      the one tag -> component map (filled by Phases 3 to 6)
  MessageMarkdown.tsx the component every message uses
  cache.ts            LRU of final trees, keyed by message ID + content hash
```

**Parsing.**

- `parseMessage` wraps Comark's parse in try/catch and returns `null` on failure.
- `MessageMarkdown` keeps the last good result per message. While `status === 'streaming'`, deltas are coalesced so parsing happens at most once per animation frame; a `null` result keeps the previous tree on screen.
- When a message reaches `done`, parse once more and store the result in the LRU (500 entries). Historical messages hit the cache on scroll-back.

**Sanitising (`sanitize.ts`), run on every tree before render.** Agent output is untrusted: it can carry text from web pages and PR comments.

- Raw HTML: disable in the parser if Phase 0 found an option; otherwise convert HTML nodes to escaped text.
- Unknown `::tags` become a neutral dashed frame labelled with the tag name and showing the block's source.
- Links and images: only `http`, `https`, `mailto` and relative URLs; links open in a new tab with `rel="noopener noreferrer"`.
- Drop `style` and every `on*` attribute. `class` from `{.class}` syntax is kept only if it is on a short allowlist (for example `max-w-*` widths the demo uses); anything else is removed so content cannot position itself over the UI.

**Blocks and threads.**

- Each top-level node renders inside `<div data-block="n">`, keeping the Phase 5 selection and highlight logic unchanged. A whole figure or diagram is one block, so it can be threaded.
- New threads store `block_text` as the node serialised back to markdown (Phase 0 found the function), so the thread prompt quotes real source, including a figure's props.
- **Re-anchoring existing threads:** a one-off script `npm run migrate:blocks` (not part of the server runtime). For each thread it parses the parent message with Comark, matches the stored `block_text` to the most similar block by normalised text, and updates `block_index` and `block_text`. Unmatched threads keep their index and are listed in the script output. It records completion in a `meta` table so it runs once.

**Streaming caret.** While streaming, a small blinking block cursor in `--graph-accent` follows the last block (CSS only).

Acceptance:

- [ ] Tests: every character prefix of a fixture mixing prose, tables, fences and `::graph-*` blocks renders without an exception reaching React; prefixes that fail to parse reuse the previous tree
- [ ] Tests: sanitiser strips `<img onerror>`, `javascript:` links, `style`, and a `{.fixed .inset-0}` class; unknown tags render the fallback frame
- [ ] Tests: block splitting, and `block_text` round-trips through parse
- [ ] Migration script re-anchors threads on a copy of the real database; zero unmatched, or each one listed
- [ ] `marked`, `dompurify` and `highlight.js` removed from `package.json`

## Phase 3: prose styling for plain markdown

Goal: a message with no components at all (headings, lists, links, tables, quotes, inline code) looks like the demo's prose.

**Style lab.** Add a dev-only route `/dev/markdown` that renders fixture files through `MessageMarkdown`, with a light/dark toggle and a width selector (message column, thread panel). Copy the demo's `content/report.md` and `content/catalog.md` into `test/fixtures/markdown/`, plus a `prose.md` fixture covering every CommonMark and GFM element. Every visual acceptance check from here on compares this page to the Phase 0 reference screenshots.

**Native element overrides** in `components.tsx`, using the exact classes and tokens recorded in Phase 0:

| Element | Treatment |
| --- | --- |
| Body text | Geist, ink colour, the demo's size and line height |
| `h1`–`h6` | Demo's heading styles, scaled one step down (a chat message is not a page) |
| `a` | Blue accent, demo's underline style; external-link behaviour from the sanitiser |
| `code` (inline) | Geist Mono, demo's muted background |
| `pre` | Handed to Phase 4 |
| `blockquote` | Demo's quote style (dashed or muted rule) |
| `hr` | Dashed line in the border token |
| `ul`, `ol`, `li` | Demo's markers and spacing, muted markers |
| Task lists | `[x]` / `[ ]` glyphs in Geist Mono, matching `graph-check`, instead of checkboxes |
| `table` | Wrapped in mdxcn's shared frame primitive (`graph-frame`) so plain tables get the same dashed frame as `::graph-table`; mono, `tabular-nums`, GFM alignment respected, horizontal scroll inside the frame |
| `img` | Max width 100%, dashed frame, alt text as the frame title |

**Message layout.** The markdown column uses the demo's max content width; figures may use the full message width. User messages use the same renderer.

Acceptance:

- [ ] Style lab `prose.md` in light and dark matches the demo's prose within a small pixel-diff tolerance (Playwright)
- [ ] Plain GFM table and `::graph-table` with the same data look alike at a glance
- [ ] Long lines, long URLs and wide tables never widen the message column

## Phase 4: Shiki code blocks

Goal: code blocks highlight with Shiki in both themes, grammars load only when a language first appears, and streaming code never stutters.

**Render time, not parse time.** Comark has a Shiki plugin that highlights during parsing ([source](https://comark.dev/rendering/react)). Here, though, parsing runs on every streamed frame, so highlighting moves into the `pre` component instead. That keeps parsing cheap and lets grammars load lazily.

- `web/src/markdown/shiki.ts`: one shared highlighter created on first use from `shiki/core` with the JavaScript regex engine (no WASM). Themes: the ones Phase 0 found in the demo, else `github-light` and `github-dark`.
- Languages load on demand via dynamic `import('@shikijs/langs/<lang>')`, cached per language. Unknown or missing language renders as plain text.
- `CodeBlock` renders plain monospaced text immediately, then swaps in highlighted HTML (`codeToHtml` with `themes: { light, dark }` and `defaultColor: false`). CSS picks the colour set from `.dark`, so switching theme needs no re-highlight.
- While a message is streaming, highlight a code block only once its fence is closed (it is not the last block, or the message is done). The open block stays plain.
- Frame: dashed border, language label as `[ TS ]` on the top edge like the graph frames, a copy button in the corner, horizontal scroll inside the frame.

Acceptance:

- [ ] First message with TypeScript loads only the TypeScript grammar (network panel check); a second TS block loads nothing
- [ ] Theme toggle changes code colours without re-running the highlighter
- [ ] Streaming a 200-line code block shows plain text, then highlights once at the end
- [ ] Style lab code samples match the demo screenshots

## Phase 5: graph components

Goal: all 32 mdxcn components and the demo's `::row` layout render from `::graph-*` blocks, identical to the demo but static, and a malformed figure never breaks its message.

1. **Install.** From `web/`, `npx shadcn@latest add https://mdxcn.dev/r/all.json` into `web/src/registry/default/`, or copy the demo's files for components Phase 0 marked as "keep demo version". Keep the MIT `LICENSE` beside them and add a credits line to the README. Treat these files as vendored: no edits except where this plan says so, and each edit gets a `// agent-chat:` comment.
2. **Tag map.** Spread `graphComponents` from `graph-comark.tsx` into `components.tsx`, add the demo's `row` component, and keep the unknown-tag fallback. If Phase 0 found gaps in `graph-comark` (prop coercion, empty frames for missing required props), wrap each entry with an adapter ported from the demo's `coerce.ts` and its `graph(Component, { numeric, required })` helper.
3. **No animation.** Wrap `.md-root` in `<MotionConfig reducedMotion="always">`. The components already drop motion to zero duration under reduced motion, so they render in their final state. Verify nothing starts at `opacity: 0` and stays there. `graph-timer` and `graph-countdown` still tick, because their value changes rather than animates: drive all of them from one shared 1-second ticker, and only while visible.
4. **Fault isolation.** Each block renders inside an error boundary. A component that throws shows the fallback frame: the tag name, the error message in muted text, and the block's source in a collapsed code block. Other blocks in the message are unaffected.
5. **Streaming.** A block whose YAML props are still arriving renders the component's empty frame at its final size (from step 2), so the layout doesn't jump when props land.
6. **Narrow widths.** Make the message column a Tailwind container (`@container`). `::row` collapses to one column below about 560 px, so figures fit the 420 px thread panel. Wide figures (heatmap, matrix, gantt) scroll horizontally inside their frame.

Acceptance:

- [ ] Style lab `catalog.md` and `report.md` match the demo screenshots in light, and render correctly in dark
- [ ] Every component has a render test with example props from the mdxcn docs, plus one with missing required props (empty frame, no throw)
- [ ] Streaming `report.md` character by character: no layout jump larger than one line, no uncaught errors
- [ ] A deliberately broken block (`rows: 5`) shows the fallback frame while the rest of the message renders

## Phase 6: Mermaid rendering

Goal: ```` ```mermaid ```` fences render as diagrams that look like part of the same visual family, Mermaid loads only when a diagram appears, and a bad diagram falls back to its source.

**Own component, not the plugin.** Comark ships a Mermaid plugin with a companion component ([source](https://comark.dev/rendering/react)). Use the app's own `MermaidBlock` routed from the `pre` component (language `mermaid`) instead, because it needs lazy loading, streaming control and theme re-renders. If Phase 0 showed the plugin already lazy-loads Mermaid and accepts theme variables, use the plugin and skip the parts below it covers.

- **Lazy.** `MermaidBlock` is a `React.lazy` chunk; `mermaid` is imported dynamically on first use and initialised once.
- **Streaming.** Render only once the fence is closed (same rule as Phase 4). Until then show the source as a plain code block with a `[ DIAGRAM ]` label.
- **Security.** `securityLevel: 'strict'` set explicitly (no click handlers, no HTML labels). The output is Mermaid's own SVG; do not let agent text reach `innerHTML` any other way.
- **Look.** Theme `base` with `themeVariables` read from the CSS tokens at render time: transparent background, node fill = background, node border and text = ink, lines = muted grey, font = Geist Mono at the demo's figure size. Add `themeCSS` making edges dashed (`stroke-dasharray`) to match the frames. Wrap the SVG in the shared dashed frame; the title comes from Mermaid's own `title:` front matter, else `[ DIAGRAM ]`.
- **Themes.** Mermaid bakes colours into the SVG, so re-render when the theme changes. Cache SVGs by (source hash, theme).
- **Errors.** On a parse error, show the source code block and a one-line muted error in the frame. Never show Mermaid's default error graphic.
- **Size.** Max width 100%; tall diagrams scroll inside the frame; a small "expand" button opens the SVG in a full-width overlay.

Acceptance:

- [ ] A chat without diagrams never downloads the Mermaid chunk (network check)
- [ ] Flowchart, sequence, state and ER fixtures render in light and dark with dashed edges and Geist Mono
- [ ] An invalid diagram shows source plus error, and the rest of the message renders
- [ ] Streaming a diagram shows source until the fence closes, then renders once

## Phase 7: teaching agents (opt-in)

Goal: agents with `render: graphs` in their frontmatter reliably emit valid `::graph-*` blocks and Mermaid fences where a figure helps; other agents are unchanged.

**Config.** New optional agent frontmatter key, validated by the config loader:

```markdown
---
name: researcher
model: sonnet
render: graphs        # adds the figure catalog to this agent's system prompt
---
```

**Prompt file.** `server/prompts/comark-graphs.md`, committed to the repo, never fetched at runtime. Build it once from mdxcn's agent material (its skill and the Comark section of `https://mdxcn.dev/llms.txt`), trimmed and adapted:

- Syntax: `::graph-name{attrs}` for scalars, a YAML props block between `---` lines for arrays and objects, closing `::`. One worked example per component.
- A chooser: which component fits which data (from the mdxcn table: table, sheet, bars, plot, heatmap, timeline, gantt and so on), and `::row{cols=2}` for pairing two small figures.
- Upstream guidance kept: prose first, at most two figures per message, only listed tags.
- **Override the upstream rule against Mermaid:** use ```` ```mermaid ```` only for relationships the graph set cannot show (sequences, state machines, entity relations, architecture); linear processes use `::graph-flow`.
- Streaming-friendly habits: write all props before any child content; never leave a YAML list half-written before prose.
- Budget: at most 4,000 tokens, checked by a test.

**Runner.** When `render: graphs` is set, `buildArgs` appends the prompt file after the agent body in `--append-system-prompt`. The text is constant, so caching works as usual. The first turn after enabling it changes `flags_hash`, which triggers the existing "cache reset: agent config changed" marker.

**Style lab.** A "Prompt" tab shows the exact catalog text, so it can be reviewed without reading the repo.

Acceptance:

- [ ] Test (fake Claude): the catalog text appears in `--append-system-prompt` only for opted-in agents; flags stay byte-identical across turns
- [ ] Test: prompt file stays under the token budget
- [ ] Real run: an opted-in agent asked to compare five PRs by size and review time answers with prose plus one or two valid figures that render without fallback frames
- [ ] Real run: asked for a login sequence diagram, it uses Mermaid; asked for a three-step process, it uses `::graph-flow`

## Phase 8: dark mode, search text and performance

Goal: dark mode is as polished as light, search results read cleanly even when they hit a figure, and the renderer stays within a measured budget.

**Dark mode.** If the demo has a dark theme, copy its values. If not, derive one in `tokens.css`: near-black background, off-white ink, the same grey scale inverted, and the blue and jade accents kept in hue but lightened until text in them passes WCAG AA (4.5:1) on the dark background. Check every component in the style lab, plus Shiki's dark theme and Mermaid, and record the final values in `NOTES.md`.

**Search snippets.** FTS keeps indexing raw `content_md`, so a value inside a figure's props is still findable. The search palette cleans the snippet on the client: `::graph-*` blocks show as `[figure: graph-table · <title>]`, YAML fences and closing `::` lines are dropped, and Mermaid fences show as `[diagram]`.

**Performance budget,** measured on this laptop and recorded in `NOTES.md`:

| Measure | Budget |
| --- | --- |
| Initial JS added by Phases 1–7 (gzipped) | 250 KB or less; Shiki grammars and Mermaid in separate lazy chunks |
| Open a channel with 200 messages including 40 figures | Under 300 ms from data to rendered |
| Parse time per streamed frame, 5,000-character message | Under 8 ms |
| Scroll through 500 messages | No long tasks over 50 ms after the first render |

Use `rollup-plugin-visualizer` for bundle size and the Performance API for timings. If the parse budget fails, move parsing into a Web Worker. Comark's output is serialisable, so only `parse.ts` changes. If the scroll budget fails, parse offscreen messages lazily with an IntersectionObserver.

Acceptance:

- [ ] Style lab passes a visual check of every fixture in dark mode, with contrast verified for accent text
- [ ] Searching a value that appears only in a figure's props finds the message and shows a clean snippet
- [ ] All four budgets met, numbers in `NOTES.md`

## Testing and definition of done

Visual correctness is judged against the Phase 0 reference screenshots through the style lab; behaviour is covered by unit tests; real agent runs are kept to the few items marked "real run".

| Layer | Tool | Covers |
| --- | --- | --- |
| Unit | Vitest | `parseMessage`, sanitiser, block splitting and `block_text` round-trip, prop coercion, snippet cleaning, prompt token budget |
| Component | Vitest + Testing Library | Every graph component with valid and missing props, error boundary fallback, code and Mermaid lazy paths |
| Streaming | Vitest | Every character prefix of the fixtures renders without an uncaught error |
| Visual | Playwright against `/dev/markdown` | Prose, code, figures, Mermaid in light and dark versus the reference screenshots |
| Integration | Fake Claude | `render: graphs` flag handling in `buildArgs` |

**Done when:**

- [ ] All phase acceptance items are checked
- [ ] Style lab fixtures match the demo in light, and dark mode passes its visual and contrast checks
- [ ] Old conversations render correctly, and every existing paragraph thread still points at the right block
- [ ] Streaming a figure-heavy answer shows no broken frames, no layout jumps beyond a line, and no console errors
- [ ] Performance budgets met and recorded; `marked`, DOMPurify and highlight.js are gone
- [ ] README credits Comark and mdxcn, with the MIT licence file next to the vendored components
