# SimForge SDK

The SimForge SDK is the open-source half of [SimForge](https://simforge.ai):

- **`simforge`**, one command-line program (Rust) that imports a scenario
  package exported from the hosted app, pulls the map and actor assets it names
  by digest, renders it with the deterministic renderer (`training` and
  `showcase` presets), re-simulates it, and serves it as a closed-loop
  environment;
- **`simforge-oss-gym`**, the Gymnasium client for that environment (Python);
- the contracts both sides share: the scenario package, the render timeline,
  the trace format and its upgraders.

Everything here is Apache-2.0. The hosted app (the Studio editor, the render
fleet) is a separate product at [simforge.ai](https://simforge.ai); the CLI is
how you run its scenarios on your own machine, air-gapped if you need to.

> **Status:** 0.2.0 is the first release of the Rust CLI. Command names and
> flags on these pages follow the 0.2 design and are checked against the
> binary on every release.

Start with [Install the CLI](install/index.md), then
[Getting started](guide/getting-started.md).
