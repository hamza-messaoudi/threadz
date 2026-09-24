::graph-flow
---
title: Deploy pipeline
rows:
  - nodes: [{ label: build image }, { label: run test suite }, { label: release to production, tone: accent }]
---
::

1. **Build the image:** Package the app and its dependencies into a versioned container image.
2. **Run the test suite:** Test that exact image, so what you verify is what you ship. A failure stops the pipeline here.
3. **Release to production:** Roll out the tested image, and only that image, to production.

The order gates each step on the one before it. Nothing untested reaches production, and the release doesn't rebuild anything.
