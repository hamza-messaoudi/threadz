Review time rises with size, but not proportionally. Small and mechanical PRs are the outliers.

::graph-table
---
title: Size vs review time
headers: [PR, Lines changed, Review (h), h per 100 lines]
align: [left, right, right, right]
rows:
  - ["#423 search index", "2,250", "41", "1.82"]
  - ["#412 auth refactor", "1,550", "26", "1.68"]
  - ["#418 billing page", "900", "19", "2.11"]
  - ["#421 bump deps", "590", "3", "0.51"]
  - ["#415 flaky test fix", "16", "1.5", "9.4"]
---
::

Lines changed is additions plus deletions.

- **Large PRs (#412, #418, #423):** these run about 1.7–2.1 h per 100 lines, so review time is roughly linear in size. #423 is the biggest and the slowest at 41 h.
- **#421 (dep bump):** it changes 590 lines but took only 3 h, about a quarter of the per-line rate of the large PRs. That fits a mechanical change, such as lockfile churn, that reviewers skim.
- **#415 (flaky test fix):** it is the smallest PR at 16 lines, yet its per-line cost is about 5x higher than the large PRs. A tiny change still has a fixed cost of understanding the flake, so 1.5 h is likely mostly context rather than reading.

The sample is only five PRs, and elapsed review time includes waiting, not just reading. Treat the ratios as rough.
