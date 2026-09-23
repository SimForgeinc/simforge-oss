# Performance benchmarks

The repository has two measurements for the same fixed, pinned corpus:

- `scripts/benchmarks/cli-render-benchmark.mjs` measures the CLI `render submit → render wait → render download` contract. It records cold and warm wall time, progress samples (including the time spent at or above 90% progress), frame throughput, simulated-seconds throughput, artifact bytes, process RSS, VRAM, GPU power/utilisation, and the render manifest's typed stage timings.
- `scripts/benchmarks/browser-app-benchmark.mjs` measures the three user-facing Studio surfaces (`/dashboard/map-assets`, `/dashboard/scenario`, and `/dashboard/simcloud`) with a new-context cold pass and a same-context warm pass. It records navigation TTI, scenario-world first 3D draw, frame-time p50/p95/p99, long tasks, WebGL draw calls, texture uploads, JavaScript resource bytes, network requests/bytes, pre-interactive assets, unused DOM-unreferenced assets, and duplicate fetches.

The scripts are intentionally standalone Node programs. They do not add a package dependency or change the application flow.

## Fixed corpus and running the measurements

All commands below run on `path-pc` in the benchmark worktree. The data root is a private clone, not the shared seeded root:

```sh
cd ~/worktrees/benchmarks
export PATH="$HOME/.cargo/bin:$PATH"

# The host recipe is in BRIEFING.md. Keep the host up only for the browser turn.
# The CLI number below explicitly names its engine. Native is preferred when
# the installed runtime reports it; browser is a legitimate separate baseline.
node scripts/benchmarks/cli-render-benchmark.mjs \
  --data-root "$HOME/sf-data-benchmarks" \
  --scenario <fixed-document-id> \
  --engine native --seconds 1 --fps 5 --width 320 --height 180 \
  --repeats 3 --out artifacts/benchmarks/cli-native-baseline

node scripts/benchmarks/browser-app-benchmark.mjs \
  --base-url http://127.0.0.1:5430 \
  --data-root "$HOME/sf-data-benchmarks" \
  --settle-ms 3000 --out artifacts/benchmarks/browser-baseline/report.json
```

The cheap one-second/5-FPS clip is a measurement workload, not a product-quality claim. It is long enough to exercise submit, simulation, rasterisation, sensor synthesis, encoding and finalisation while keeping repeats affordable. Any substitution (for example, the Richmond seeded 20-second path shortened to a known on-network prefix) must be written in the report and must not be presented as evidence that the original input works.

A CLI run reports `engine: browser` when called with `--engine browser`; those numbers are CLI orchestration around browser rendering and are never labelled native. A requested native run that fails remains a failed native run. The native runtime's availability and revision are recorded by the job's machine/manifest evidence.

## Metric definitions

### CLI/render

`cliSubmitFreezeAndCompileWallMs` is the measured `render submit` wall time. The public render-job DTO does not expose independent map/asset preparation and scenario-compile counters, so the report does **not** invent a split: those two fields are explicitly `null` with that reason, while the combined wall time remains visible. `cliWaitToTerminalWallMs` is the measured `render wait` wall time. `progress90ToTerminalMs` is the separately measured tail that catches the historical progress-at-0.9 stall.

When a browser/native render manifest is present, the instrumented stages are:

- `simulationStepping` — `worldUpdate` totals;
- `frameRasterisation` — `scenePass` totals;
- `sensorSynthesis` — `readback` totals;
- `encodeFinalise` — encoder, visualisation and artifact-write totals.

`instrumentedTotalMs` and `uninstrumentedWaitMs` make queueing, browser startup and any missing worker telemetry visible rather than hiding them in a total. Throughput is frame count divided by end-to-end seconds and simulated-seconds divided by end-to-end seconds. RSS is the process tree peak; VRAM is the maximum `nvidia-smi` sample, not a claim about allocation attribution. Artifact bytes are the downloaded output directory size.

### Browser/app

The browser harness runs one route cold and once warm in the same browser context. TTI is the navigation `domInteractive` timestamp. First 3D frame is the first intercepted WebGL draw on a canvas below `[data-testid="scenario-world-host"]`; static map/switcher canvases are not counted. Frame times are the RAF interval distribution, reported as p50/p95/p99, not a mean. Long tasks come from `PerformanceObserver('longtask')`.

Draw calls and texture uploads are WebGL method interceptions. Upload bytes are an estimate for typed arrays and width×height calls. `jsBytesShipped` is transfer bytes for script resources and `jsBytesExecuted` is decoded bytes for loaded script resources (a conservative browser-observed execution proxy, not CPU instruction bytes). `unusedAssetBytes` means asset-like responses whose absolute URL is not present in a `src`/`href` at measurement stop; dynamically consumed textures are therefore reported as uncertain by the definition rather than silently counted as used. `assetsFetchedBeforeInteractive` and duplicate URL counts make unnecessary early and repeated work visible.

## Fidelity and invariant gate

A candidate speed win is not accepted without `scripts/benchmarks/quality-gate.mjs` against a pinned reference directory:

```sh
node scripts/benchmarks/quality-gate.mjs \
  --reference artifacts/benchmarks/reference \
  --candidate artifacts/benchmarks/candidate \
  --out artifacts/benchmarks/candidate/quality-gate.json
```

The declared defaults are hard: mean PSNR ≥ **35 dB**, mean SSIM ≥ **0.98**, and mean VMAF ≥ **90**. If the installed ffmpeg does not expose `libvmaf`, VMAF is **not measured and the gate rejects**; it is never assumed to pass. The gate compares all paired PNG/JPEG/WebP frames, or extracts up to 120 frames from a video artifact when individual frames are absent.

The following invariants must pass exactly and are independent of perceptual tolerance:

1. frame count;
2. schedule/timing synchronisation;
3. geometry and actor poses from the trace/instance/sensor-frame documents;
4. the determinism claim in `docs/engineering/determinism-claim.md`: symbolic engine traces and structured sensor semantics must remain byte-stable for the same input. Chrome RGB bytes are not used as identity because that document records their measured instability.

A failed invariant, missing pixel pair, or missing metric is a rejection. PNG versus JPEG/WebM is therefore a legitimate optimization only when the measured gate passes and the exact trajectory/timing/geometry invariants do not drift.

## Statistical treatment

Each benchmark uses a fixed corpus, one cold iteration, and at least two warm repeats. Reports include medians, p95/p99 where meaningful, median absolute deviation (MAD), and relative MAD. The dispatcher refuses to call a candidate an improvement when its relative wall-time improvement is ≤ `max(5%, 2 × max(baseline relative MAD, candidate relative MAD))`. That is the minimum detectable effect (MDE), not a promise that smaller effects do not exist. A rejected candidate is appended to the scoreboard with `status: rejected` and a reason such as `inside noise floor`, `quality gate failed`, or `invariant failed`.

GPU clocks/power are **not pinned** on the shared RTX 5080: the current observed clock/power state is recorded with every report, and repeats/robust statistics compensate instead of pretending the box is quiet. Machine hostname, kernel, load average, memory, driver, observed/max clock, VRAM, utilisation and power are recorded at measurement time. Benchmark measurement must be serialized with other GPU users; never run a measurement while another agent owns the render slot.

## OpenResearch experiments and optimizer loop

`orx` is wired using its actual local schema, not a checked-in guessed YAML format. `orx up` starts the local dashboard; an existing checkout is imported there, then child experiment nodes are created with the CLI's real commands:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
orx up --no-browser --no-agent --port 4799
# Import this checkout in the dashboard, then copy the returned local project ID.
orx projects
orx create-experiment <PROJECT_ID> \
  --title 'Eliminate unused render work' \
  --description 'Avoid redundant passes/copies while preserving the quality gate.' \
  --run-command 'node scripts/benchmarks/cli-render-benchmark.mjs'
orx create-experiment <PROJECT_ID> \
  --title 'Perceptually free representation/encode path' \
  --description 'Choose representations matching access patterns; accept encode savings only through the gate.' \
  --run-command 'node scripts/benchmarks/browser-app-benchmark.mjs'
```

The actual schema is: a local project ID, experiment title/description, optional parent, and a shell `--run-command`; `orx exp run <EXP_ID>` supervises the command and `orx runs <PROJECT_ID>` lists scoreboarded runs. The two nodes are genuine architectural directions, not compiler-flag roulette.

`scripts/benchmarks/dispatch-optimizers.mjs` is re-runnable. It creates two isolated worktrees, dispatches both directions concurrently, then serializes benchmark measurement and appends one JSONL row per direction to `artifacts/benchmarks/scoreboard.jsonl`. The agent prompts tell each optimizer what it may change and which invariants it must preserve. A row is written even when the agent fails, the benchmark cannot run, the candidate is inside noise, or the quality gate rejects it.

The dispatcher accepts `--runner codex` or `--runner claude`; it maps them to the installed CLIs and enforces `--max-time` as a subprocess timeout. A custom executable is also accepted. On this box, `orx up` reported Codex authenticated and Claude requiring `claude auth login`; no unavailable Claude run is presented as evidence.

For Codex, the concrete non-interactive shape is:

```sh
codex exec --model opus-5 --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check --cd <optimizer-worktree> \
  "<direction prompt>"
```

Model authentication and quota are part of the recorded scoreboard row; a failed optimizer invocation is retained as a rejected row rather than silently replaced.

## Baseline ledger

The baseline ledger is committed only after a real run. It must include the full report path, exact command, engine, corpus identity and machine fingerprint. Do not fill these fields with estimates. If a leg cannot be captured, leave its metric `null` and state the operational reason in the report. In particular, a browser-only machine cannot claim native timings, and an ffmpeg build without libvmaf cannot claim VMAF.

## Map load (web studio)

`pnpm bench:map-load` (`scripts/benchmarks/map-load-benchmark.mjs`) measures how long a map takes to become usable and interactive in the web studio, per map, rendering setting (`low-no-foliage`, `low`, `medium`) and surface (scenario editor, free drive). It runs a real Chrome with GPU flags (`--gpu vulkan`, the default, is ANGLE on Vulkan), cold then warm: the first run of each (map, setting) starts from an empty profile, and every later run reuses the profile with a fresh browser process. A warm run is a returning user whose map cache holds everything.

```sh
# Against a local host (private SIMFORGE_CLOUD_ROOT; never the user's ~/.simforge/cloud):
pnpm bench:map-load --base-url http://127.0.0.1:5199 --data-root "$SIMFORGE_CLOUD_ROOT" \
  --maps richmond-field-station,belmont-research-center --settings low-no-foliage,medium \
  --modes editor,drive --runs 4 --budgets config/bench/map-load-budgets.json --out artifacts/bench/map-load
# Against a deployment: SIMFORGE_BENCH_EMAIL / SIMFORGE_BENCH_PASSWORD instead of --data-root.
# --trace writes a Chrome trace (with CPU samples) of the last warm run of each surface.
```

Stages, in milliseconds after navigation start:

- `contextMs`: the viewer's WebGL2 context exists, i.e. the application has booted.
- `firstFrameMs`: the viewer's first map draw.
- `usableMs`: roads and every in-view cell are on screen.
- `interactiveMs`: the surface accepts input. For the editor, the world is loaded. For drive, the session has its car and no status overlay.
- `fullMs`: nothing is loading, queued or uploading.

Structural counts: Cache Storage reads and bytes, map network requests, Basis transcodes, meshopt decodes, browser-pack inflates, compressed texture bytes uploaded, programs linked, albedo GPU readbacks and main-thread long tasks.

The run exits 1 when a budget in `config/bench/map-load-budgets.json` is exceeded. Time budgets bound the warm median; count budgets bound the warm maximum, because a structural regression (a map without its pack, a Basis transcode on a GPU-native tier) shows up in every run. The budget evaluator is unit-tested in CI (`pnpm test:bench`). The benchmark itself runs on the RTX 5080 self-hosted runner (`.github/workflows/map-load-bench.yml`): a load-time budget is only meaningful on the GPU it was set on. Every run records the host's one-minute load average, because the 5080 box is shared, and a run on a busy host is not evidence of a regression.
