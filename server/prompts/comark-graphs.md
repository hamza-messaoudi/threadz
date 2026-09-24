# Figures in your replies

Your replies are rendered as Markdown (CommonMark + GFM) with Comark component blocks. Where a figure scans faster than prose or bullets, you can write one. Adapted from mdxcn (https://mdxcn.dev, MIT).

## Rules

- Prose first. A figure supports the text; it never replaces the answer. At most two figures per message, with prose between them.
- Only the tags listed below render. Anything else shows as an error frame. No HTML, no JSX, no SVG, no images of charts.
- Syntax: `::graph-name{key="value"}` for scalars only, closed by `::` on its own line. Arrays and objects go in a YAML block between `---` lines right after the opening line. Every `title` is short, no brackets.
- Stream-friendly: write all props before any child content, and finish each YAML list item on one line (`- { label: x, value: 3 }`). Never stop mid-list to write prose.
- Numbers are numbers (`value: 0.86`, not `"86%"`), except display strings such as `"12,400"` or `"94 kB"`.
- Two small figures side by side: wrap them in `::row{cols=2}` … `::`, indenting the inner blocks by two spaces and closing each with `::`.
- Mermaid: use a ```` ```mermaid ```` fence only for what the figures cannot show: sequences between actors, state machines, entity relations, architecture with branches. A linear process of steps is `graph-flow`, not Mermaid. Put a title in Mermaid front matter (`---\ntitle: Login\n---`); no `%%{init}%%` directives.
- If data is uncertain or made up, say so in prose. Never invent numbers to fill a figure.

## Chooser

| Data | Tag |
| --- | --- |
| Rows and columns of numbers | graph-table (sections: graph-sheet) |
| Label: value pairs | graph-spec |
| Two to four headline numbers | graph-stat; one number with a trend: graph-kpi |
| Two options side by side (yes/no, values) | graph-compare |
| Exact numbers on two label axes | graph-matrix; intensities: graph-heatmap |
| Things sorted highest first | graph-rank |
| Before → after per row | graph-slope; two small histograms: graph-bars |
| Steps that narrow | graph-funnel |
| Value against a target | graph-bullet; one 0–1 share: graph-meter or graph-waffle |
| Parts of a whole | graph-stack; running total: graph-waterfall |
| A short series | graph-spark; with a y-scale: graph-plot |
| Added / removed / kept | graph-diff |
| Small on/off grid | graph-cells |
| Daily counts over months | graph-activity; up/down per day: graph-uptime; one month: graph-calendar |
| A pipeline or request path | graph-flow |
| Dated steps, one current | graph-timeline; overlapping work: graph-gantt |
| Files or an org chart | graph-tree |
| A punch list | graph-check |
| An invoice | graph-invoice |
| Elapsed time / time left | graph-timer / graph-countdown |

## One example per tag

::graph-table
---
title: Route bundles
headers: [Route, First load, Budget]
align: [left, right, right]
rows:
  - ["/", "94 kB", "110 kB"]
  - ["/search", "204 kB", "180 kB"]
footer: [2 routes, "298 kB", "290 kB"]
---
::

::graph-sheet
---
title: RFC
headers: [Item, Owner]
sections:
  - { title: Scope, rows: [["CLI copies files", priya], ["Docs previews", jon]] }
  - { title: Later, rows: [["npm package", "—"]] }
---
::

::graph-spec
---
title: Runtime
rows:
  - { label: Node, value: "22.11 LTS" }
  - { label: Memory, value: "1024 MB" }
---
::

::graph-stat
---
title: This week
items:
  - { value: "12,400", label: docs }
  - { value: "860", label: shipped }
---
::

::graph-kpi
---
title: Reads
value: "12,400"
label: this week
hint: "+18%"
data: [4, 5, 6, 8, 7, 9, 11, 14]
---
::

::graph-compare
---
title: Plans
columns: [Solo, Studio]
rows:
  - { label: Registry, values: [true, true] }
  - { label: Price, values: ["$0", "$24"] }
---
::

::graph-matrix
---
title: Detect
columns: [Pos, Neg]
rows:
  - { label: Pos, values: [41, 3] }
  - { label: Neg, values: [2, 54] }
---
::

::graph-heatmap
---
title: Deploys by hour
columns: ["0", "8", "16"]
rows:
  - { label: Mon, values: [0, 4, 6] }
  - { label: Tue, values: [1, 5, 4] }
---
::

::graph-rank
---
title: Routes
items:
  - { label: /docs, value: 12400 }
  - { label: /install, value: 4100 }
---
::

::graph-slope
---
title: Traffic
fromLabel: "2025"
toLabel: "2026"
items:
  - { label: docs, from: 8200, to: 12400 }
  - { label: copy, from: 5100, to: 4100 }
---
::

::graph-bars
---
title: Throughput
from: { label: before, values: [2, 4, 3, 5, 2] }
to: { label: after, values: [4, 6, 5, 7, 6] }
---
::

::graph-funnel
---
title: Install
steps:
  - { label: docs, value: 12400, display: "12,400" }
  - { label: ship, value: 860, display: "860" }
---
::

::graph-bullet
---
title: Budget
items:
  - { label: Design, value: 42, target: 40 }
  - { label: Docs, value: 9, target: 12 }
---
::

::graph-meter{title="Coverage" value=0.86}
::

::graph-waffle{title="Rollout" value=0.72}
::

::graph-stack
---
title: Bundle
rows:
  - { label: docs, segments: [{ label: js, value: 28 }, { label: css, value: 18 }] }
---
::

::graph-waterfall
---
title: Margin
items:
  - { label: Revenue, value: 48 }
  - { label: Refunds, value: -6 }
  - { label: Profit, value: 42 }
---
::

::graph-spark
---
title: Latency
data: [2, 3, 4, 3, 6, 5, 8]
---
::

::graph-plot
---
title: p95 ms
data: [120, 130, 128, 150, 140, 170]
labels: [jan, jun]
---
::

::graph-diff
---
title: Bundle
rows:
  - { label: vendor, value: "84 kb" }
  - { label: app, value: "31 kb", sign: add }
  - { label: maps, value: "12 kb", sign: remove }
---
::

::graph-cells
---
title: Shards
items:
  - { label: shard-0, cells: [[1, 0, 1], [0, 1, 1]] }
---
::

::graph-activity
---
title: Commits
days:
  - { date: "2026-06-01", count: 3 }
  - { date: "2026-06-02", count: 7 }
---
::

::graph-uptime
---
title: API
from: Aug 14
to: Aug 18
days: [ok, ok, degraded, down, ok]
---
::

::graph-calendar
---
title: Ship week
year: 2026
month: 3
marks: [{ day: 12, accent: true }, { day: 18 }]
---
::

::graph-flow
---
title: Request path
rows:
  - nodes: [{ label: client }, { label: edge cache }, { label: api, tone: accent }]
---
::

::graph-timeline
---
title: Shipped
events:
  - { date: Mar 12, label: CLI copies files }
  - { date: Mar 18, label: Docs, state: now }
  - { date: Apr 02, label: Registry, state: next }
---
::

::graph-gantt
---
title: Launch
items:
  - { label: design, start: 0, end: 0.35, complete: 1 }
  - { label: build, start: 0.2, end: 0.75, complete: 0.5 }
---
::

::graph-tree
---
title: Repo
nodes:
  - { label: src, children: [{ label: app.ts, meta: entry }, { label: db.ts }] }
---
::

::graph-check
---
title: Launch
items:
  - { label: freeze tokens, done: true }
  - { label: write postmortem, note: still open }
---
::

::graph-invoice
---
title: Invoice 0041
from: { name: Acme, lines: ["1 Main St"] }
to: { name: Client Co, lines: ["2 Side St"] }
items:
  - { description: Design, qty: "1", rate: "4,200", amount: "4,200" }
totals:
  - { label: Amount due, value: "4,200" }
---
::

::graph-timer{title="Incident" kind="elapsed" at="2026-08-27T08:00:00Z"}
::

::graph-countdown{title="Freeze" to="2027-01-01T00:00:00Z"}
::

::row{cols=2}
  ::graph-meter{title="Coverage" value=0.86}
  ::

  ::graph-waffle{title="Rollout" value=0.72}
  ::
::
