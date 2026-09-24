The same data as a plain GFM table and as a `::graph-table`.

| Route | First load | Budget |
| :-- | --: | --: |
| / | 94 kB | 110 kB |
| /search | 204 kB | 180 kB |

::graph-table
---
title: Route bundles
headers: [Route, First load, Budget]
align: [left, right, right]
rows:
  - ["/", "94 kB", "110 kB"]
  - ["/search", "204 kB", "180 kB"]
---
::

::row{cols=2}
  ::graph-meter{title="Coverage" value=0.86}
  ::

  ::graph-waffle{title="Rollout" value=0.72}
  ::
::
