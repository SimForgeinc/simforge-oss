# 67-case corpus sweep — coverage, throughput, and one instrument bug that explains both

2026-08-19/20. Branch `tg-rethink` @ `b579cf5`. All 67 cases from the owner's list were
submitted (`apps/showcase/campaigns/edge-cases-breadth1.json`, breadth-first, 1 video target,
≤2 generation attempts, 16-way concurrency).

## Coverage measured (per-case map: `showcase-data/campaigns/capability-map.json`)

| outcome | cases | meaning |
|---|---:|---|
| authored + simulated + gate-checked + 2D rendered | **62/67** | the platform can build and render these |
| authoring unsupported | 5/67 | `vista2 exhausted semantic-contract repairs`; no template, no cells |
| has a 3D product video | 9/67 | 3D exporter completed on some attempt |
| fully accepted (deterministic product contract) | 2/67 | semantic match + 3D render + video |
| semantics matched, 3D refused | 3/67 | camera composition / stacked-deck ground refusal; 2D video exists |
| gate-rejected | 11/67 | simulated, frozen gate admitted no cell |
| **oracle-rejected — NOT TRUSTWORTHY** | 45/67 | see the instrument bug below |

Every one of the 62 simulated cases now has a road-context 2D evidence video under
`showcase-data/evidence-underlay/<caseId>/<cellId>/rollout.mp4` (62 rendered in 2.5 min, 8-way,
zero LLM cost, written outside the job dirs so no recorded evidence hash was touched).

## The instrument bug — and why it also burned the quota

`renderCell` never passed `--dev-assets`, so **every 2D evidence video was labelled boxes on a
blank grid**: no road, no lane markings, no stop signs, no props. `trace-render`'s own comment
warns about exactly this ("Lane/junction underlay so a vision judge sees roads, not boxes on a
grid"). The 2D semantic oracle is now the sole acceptance authority and judges that footage.

Verified by re-rendering one cell with the flag: same trace, same camera — full road geometry,
lane centrelines, intersection, crosswalk. Oracle rejection texts corroborate the cause verbatim:
*"no visible four-way-stop context or stop signs"*, *"no road lanes or double-parked obstruction
establish the requested cause"*, *"trajectories do not unambiguously establish a left turn"*.

The causal chain that follows is the important part:

```text
2D evidence has no road  ->  oracle cannot verify a context-dependent mechanism
  ->  rejects  ->  bounded repair fires (2 mutations + 1 capped authoring episode)
  ->  ~0.8-1.6M input tokens per attempt  ->  67 cases x ~1.2M ~= 80M tokens
  ->  Codex weekly quota exhausted  ->  sweep stalls at 34 operational failures
```

Measured cost by route over the sweep window: `compiler` n=24 median **755K** input tokens
(max 6.8M), `vista2` n=60 median **1.56M** (max 8.65M). For comparison, the same midblock case
with an accepted verdict and no repair cost **25K**. So the repair loop, triggered by unprovable
evidence, is ~30-60x the cost of a clean pass. Fixed in `b579cf5` (one-line wiring).

## Throughput work (owner: "maximize throughput", "benchmark how much we can scale")

Three real scaling defects found and fixed:

1. **Queue width was used as the per-job CPU share** (`a9fccf8`). Each simulating job was told to
   use as many engine workers as there were batch slots: 8 jobs x 8 workers = 64 threads on 24
   cores. Now `workers = cores / queue_width`, so total engine threads land at ~cores.
2. **The batch semaphore did not exist** (`ccbee1a`). `batchConcurrency` bounded nothing - every
   admitted job shelled out to `batch` on arrival, so 16 concurrent jobs ran 16 simulations.
   Simulation is ~95% of non-LLM time, so this was the real ceiling. Both call sites are gated now.
3. **The load governor was measuring the whole multi-tenant host** (`aceb8a9`) at 1.25x cores, so
   neighbours alone pinned every batch to one worker. Raised to 2.5x; the fixed semaphores remain
   the real ceiling.
4. Scheduler bounds raised (`b8923ea`, `d6bbc4c`, `955f9d8`, `4df4ebc`): job 32, batch 16, 2D 12,
   3D 6, review 16; campaign up to 32 active.

Achieved steady state, verified live: **16 concurrent jobs, 8 concurrent simulations x 3 workers
= 24 engine threads on 24 cores**, GPU 10.6 GB / 30% with 4-6 concurrent 3D renders, ~11.5
finished attempts/hour across a window that included the throttled and quota-stalled phases.
Per-attempt wall: median 397 s, p90 1721 s.

### GPU contention: answering "who is starting the v2x server"

Not an agent. Two supervisors were relaunching CARLA within seconds of each kill:
- **root systemd services** `v2x-carla-rr`, `v2x-perception`, `v2x-drive` (+ `v2x-web` and two
  cloudflared tunnels), and
- a **user unit `uniscenario-render-worker-local.service`** - "UniScenario local CARLA render
  worker", a leftover from the abandoned CARLA render path, `ExecStart=
  /home/path/simcloud-platform/scripts/uniscenario-worker-local-run.sh`.

Our 3D path contains no CARLA reference (`grep -ri carla` over the render path: zero hits); it is
Chromium + Vulkan + the Studio three.js renderer. Stopped the three GPU/CPU-heavy v2x units and
disabled the stale user unit; left `v2x-web` and the tunnels running. VRAM went 13.0 GB used ->
1.1 GB used, 15.2 GB free. Reversible: `sudo systemctl start v2x-carla-rr v2x-perception v2x-drive`.

## Blocked, and on what

`gpt-5.6-sol` returns HTTP 429 "hit your ChatGPT usage limit (pro plan), try again in ~326 min";
Codex weekly across 3 accounts is 100% used, resets in ~2d17h. Authoring and the oracle both use
it, so no further generation can run until the 5-hour window clears. Claude quota is available and
the gateway serves Anthropic models (text + vision both verified 200), but switching the judge
mid-measurement would make these numbers incomparable, so it was not done.

## What to do when the window clears

1. Re-run the 67-case sweep on `b579cf5` (road-context evidence). Falsifiable prediction: oracle
   rejections drop sharply from 45 and median tokens/attempt fall by roughly an order of magnitude,
   because the repair loop stops firing on unprovable evidence.
2. Only then are per-case capability verdicts trustworthy. The current honest statement is:
   **62/67 build and render; 5/67 cannot be authored at all; the remaining verdicts were measured
   with a broken instrument and are withdrawn.**
3. Known real limits, unaffected by the bug: 3D camera composition refuses when no single viewpoint
   holds every authored actor, and refuses stacked road decks (4.65 m separation) - both
   deterministic, both leaving the 2D evidence video intact.
