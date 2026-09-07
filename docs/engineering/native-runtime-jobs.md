# Native runtime jobs (`simforge-runner`)

`simforge-runner` (`native/crates/simforge-runner`) is the durable headless
host for native execution. It owns everything around a job — identity,
inputs, resources, lifecycle, ownership, cancellation, checkpoints and
artifact verification — and links the execution crates directly through the
`JobEngine` boundary (`src/engine.rs`). It has no UI, network or cloud
scheduler: the local Studio host and the existing SimCloud workers call the
CLI; cloud lease/fence ownership stays with the cloud worker and is passed
through opaquely.

## Discovery and identity

| What | Where |
|---|---|
| Install root | `$SIMFORGE_NATIVE_RUNTIME_ROOT`, else the OS data directory (see defaults below) |
| Binary | `$SIMFORGE_RUNNER_BIN`, else `<install-root>/bin/simforge-runner[.exe]`, else `PATH` |
| Writable worker root | `--root`, `$SIMFORGE_NATIVE_RUNTIME_STATE_ROOT`, else the OS state directory (see defaults below) |
| Runtime manifest | `$SIMFORGE_RUNTIME_MANIFEST`, else `runtime-manifest.json` beside the binary |

The runtime manifest (`simforge.native-runtime/v1`) pins the binary's sha256,
source revision, target, crate versions, support tiers and every other
bundled component (render service, FFI library, provider wheels) by digest
and tier. The runner hashes its own executable at startup and refuses to run
jobs if the manifest does not describe it. `runtimeId` (canonical sha256 of
the manifest) is recorded in every job state and artifact manifest;
checkpoints only resume on the same `runtimeId`. `runtime show` reports each
component with `installed: true|false` after re-hashing it in place.
Runtime inspection does not open or create worker state. Local Studio assigns
its worker state to `<SIMFORGE_CLOUD_ROOT>/native-runtime` unless explicitly
overridden; packaged assets may remain on a read-only AppImage mount.

Installed assets and writable worker state are separate. Names follow the
target (`.exe`, `libsimforge_render.so` / `libsimforge_render.dylib` /
`simforge_render.dll`, venv `bin/python` / `Scripts\python.exe`):

```
<install-root>/runtimes/<version>-<revision12>-<runnerSha12>/   one immutable installed runtime
    bin/simforge-runner[.exe]  bin/native-render-service[.exe]  bin/runtime-manifest.json
    lib/<render library>       share/licenses/  share/sky/ (SOURCES.json + NASA-derived plates)
    wheels/*.whl  venv/        provider bundles only (--providers): wheels + venv built in place
<install-root>/bin lib share wheels venv   links (junctions on Windows) into the active generation
<state-root>/cas/  <state-root>/jobs/  <state-root>/worker/
```

Default roots: install `${XDG_DATA_HOME:-~/.local/share}/simforge/native-runtime`
(Linux), `~/Library/Application Support/simforge/native-runtime` (macOS),
`%LOCALAPPDATA%\simforge\native-runtime` (Windows); state
`${XDG_STATE_HOME:-~/.local/state}/simforge/native-runtime` (Linux),
`…/Application Support/simforge/native-runtime-state` (macOS),
`%LOCALAPPDATA%\simforge\native-runtime-state` (Windows).

Build/package/install are Node scripts under `scripts/native-runtime/` and
need only cargo, git and node on the target host (no bash, tar or sha256sum):

```
node scripts/native-runtime/package-runtime.mjs --target <triple> [--providers] [--no-sky|--sky <dir>] [--offline]
node scripts/native-runtime/install-runtime.mjs dist/native-runtime/simforge-native-runtime-<version>-<triple>.tar.gz [--root <dir>] [--python <interp>] [--extras a,b]
```

`build-runner.mjs` builds the runner and (unless `--no-sky`) the render
service + library — `--features gpu-interop` only for Linux targets, where the
opaque-fd Vulkan→CUDA bridge exists — and, only with `--providers`, the
provider wheels; the CPU/compiler/Bevy baseline needs no Python, CUDA or
research environment. It writes the manifest with
`write-runtime-manifest.mjs`, which emits only the tiers the bundle carries
and resolves each tier's qualification for that exact target from
`support-tiers.json` (`qualifiedTargets`); any other target ships the tier
`unqualified` with an explicit blocker, because source portability is not
execution evidence. The built runner's `runtime show` self-check runs only
when the target is the build host; a cross-built binary is never executed on
the build machine. `package-runtime.mjs` stages exactly the manifest closure,
writes `SHA256SUMS` and packs a gzip'd ustar archive with Node's zlib
(`runtime-archive.mjs`; the desktop stage imports the same reader/verifier).
`install-runtime.mjs` verifies the archive, refuses a foreign-target bundle,
creates the generation (identical re-installs reuse it; a different bundle
under the same name is an error; old generations are never pruned because
jobs may be pinned to them), builds the provider venv at its final path with
isolated import checks when wheels are present, repoints the root links
(rename(2) on POSIX; remove+recreate junction on Windows) and runs
`runtime show`. A supported fresh install therefore needs no source tree or
`PYTHONPATH`; GPU/driver/external-asset prerequisites per tier are reported
by each provider's `capabilities`, never assumed. Each tier carries a
`qualification` block (`qualified` | `unqualified` + blockers + separately
retained `observed` evidence); a tier is promoted for a target only after
Main's named gates pass on the installed bundle there (for
`bevy-sensor-render`: inspected non-blank, scene-dependent renders and a
complete resource closure — a green build or byte parity is not enough).

### OS primitives

`native/crates/simforge-runner/src/platform/` holds one implementation per
OS family with identical semantics (nothing is cfg-disabled to a no-op):

| Need | Unix (Linux, macOS) | Windows |
|------|---------------------|---------|
| owner lock | `flock(LOCK_EX\|LOCK_NB)` | `LockFileEx` on one byte far past the owner record (record stays readable) |
| `job start --detach` | `setsid()` | `CREATE_NEW_PROCESS_GROUP \| CREATE_NO_WINDOW` |
| `job cancel` → owner | `kill(SIGTERM)` | `SetEvent` on `Local\SimForgeRunner.Terminate.<pid>` |
| owner → provider child | `kill(SIGTERM)` | `GenerateConsoleCtrlEvent(CTRL_BREAK)` to the child's own group (`signal.SIGBREAK`) |
| receive stop | `sigaction`; `SIGHUP` ignored | console ctrl handler + named-event waiter |
| durable rename / publish | `rename`/`link` + dir fsync | `MoveFileExW(WRITE_THROUGH)` + directory flush |
| read-only blob | `chmod 0444` | `FILE_ATTRIBUTE_READONLY` |
| capacity probes | `sysconf`, `statvfs` | `GlobalMemoryStatusEx`, `GetDiskFreeSpaceExW` |

The `cancel.request` file remains the durable cancellation path on every OS;
the OS request only shortens the owner's reaction time. Hosts spawning the
runner on Windows should pass `windowsHide: true` so a detached job gets a
hidden console rather than a window.

## CLI contract

stdout is one JSON document (`--pretty` to indent); stderr carries
`{code, path?, reason, detail?}`; exit `0` ok, `1` could not run, `2` input
rejected. `--help` prints the surface as JSON. `job attach` is the one
streaming command (JSON lines, then a final
`simforge.native-job-attach-end/v1` document).

```
runtime show
job submit <manifest.json>           job start <jobId> [--detach] [--restart]
job run <jobId> [--restart]          job status <jobId> | job list
job cancel <jobId> [--reason ..]     job attach <jobId> [--from-sequence N]
job artifacts <jobId>                worker reconcile | worker capacity
cas ingest <path> | cas verify <sha256>
```

## Job manifest (`simforge.native-job/v1`)

```json
{
  "schema": "simforge.native-job/v1",
  "jobId": "study-42.sim.001",
  "workload": "simforge.simulate/v1",
  "params": { "batchTicks": 50, "checkpointEveryTicks": 500 },
  "inputs": [
    { "inputId": "scenario.input", "sha256": "…", "sizeBytes": 1234, "source": { "kind": "file", "path": "instance.json" } },
    { "inputId": "map.topology",   "sha256": "…", "sizeBytes": 99999, "source": { "kind": "cas" } }
  ],
  "resources": { "cpuThreads": 2, "memoryBytes": 2147483648, "scratchBytes": 1073741824, "gpus": [], "wallClockSeconds": 3600 },
  "outputs": [
    { "outputId": "trace", "relativePath": "trace.json.gz", "mediaType": "application/gzip" },
    { "outputId": "input", "relativePath": "input.normalized.json", "mediaType": "application/json", "required": false },
    { "outputId": "result", "relativePath": "result.json", "mediaType": "application/json", "expectedSha256": null }
  ],
  "runtime": { "runtimeId": "…" },
  "lease": { "leaseId": "…", "fenceToken": "…" }
}
```

- The manifest is immutable; its canonical sha256 is the job's input
  identity. Resubmitting an identical manifest is idempotent; a different
  manifest under the same `jobId` is rejected.
- Inputs are declared by digest. `file` sources are verified and copied into
  the worker's content store at submission (the source is never modified or
  removed); `cas` sources must already be present. Engines see read-only
  files at `workspace/<relativePath | inputs/<inputId>>`.
- `resources` are bounded declarations checked at admission against
  `worker/capacity.json` (`simforge.worker-capacity/v1`) or a probed host
  capacity that never includes GPUs. GPUs are exclusive, owned through
  `worker/locks/gpu-<index>.lock`.
- `outputs` are the contract: every `required` output must be produced, the
  runner re-hashes each file against the engine's claim, and a pinned
  `expectedSha256` makes a replay fail if bytes differ. Only then are outputs
  renamed into `outputs/`, copied into the store and `artifacts.json`
  (`simforge.native-artifacts/v1`) written.
- `runtime` pins the job to one runtime identity; `lease` is opaque cloud
  ownership recorded in every event and in `artifacts.json`.

## Lifecycle and ownership

```
queued ──start──▶ preparing ──▶ running ──▶ completed
  │                  │            │  └────▶ failed   (retryable → start again)
  │                  │            └───────▶ canceled
  │                  └── owner died ──────▶ interrupted ──start──▶ preparing …
  └──cancel─────────────────────────────▶ canceled
```

Per job: `manifest.json` (created once), `state.json`
(`simforge.native-job-state/v1`, replaced atomically), `events.jsonl`
(append-only, monotonically sequenced), `owner.lock` (an `flock` held by the
executing process; the kernel releases it on any death, so liveness is never
a pid guess), `checkpoints/` (atomically published `NNNNNNNNNNNN/` dirs with
a hashed `checkpoint.json`, `latest.json`), `staging/`, `outputs/`,
`artifacts.json`, `logs/`.

- `job start --detach` re-executes the binary as `job run` in a new session
  with stdio in `logs/`; closing Studio or the terminal does not affect it.
- `job cancel` cancels unowned jobs immediately; for an owned attempt it
  writes `cancel.request` and sends SIGTERM. Engines poll the cancel token at
  tick-batch/episode/checkpoint boundaries, so cancellation lands on a real
  engine boundary and is recorded as `canceled` with the reason.
- `worker reconcile` (run at host boot) marks active jobs without a live
  owner `interrupted`. It removes only stale store temporaries — never
  blobs, source files, checkpoints or outputs.
- `job start` on an interrupted or retryable-failed job continues from the
  latest checkpoint after re-hashing every checkpoint file; `--restart`
  discards checkpoints and reruns from the immutable inputs. A checkpoint
  from a different `runtimeId` is refused, not silently restarted.
- Job state never says `completed` before the artifact contract verified.

## Workloads

| Workload | Inputs | Outputs | Continuation |
|---|---|---|---|
| `simforge.compile/v1` | `template` (authoring document); map from the installed cache by `params.mapId` (`SIMFORGE_MAPS_CACHE_ROOT`), topology/collider digests pinned | `instance` (normalized `SimScenarioInput`, required), optional `manifest` (compiler `InstanceManifest` with replay key, site, issues) | none (single compile) |
| `simforge.simulate/v1` | `scenario.input` (canonical `SimScenarioInput` JSON), `map.topology` (decoded topology index, plain/gzip), optional `map.colliders` | `trace` (gzipped current `SimTrace` JSON, required), optional `input` (normalized executed input), `result` (issues, arrival solutions) | `Simulation::checkpoint` every `checkpointEveryTicks` |
| `simforge.episode-batch/v1` | `scenario.input`, `map.topology`, optional `map.colliders`, `policy.actions` (recorded `simforge.policy-action-schedule/v1`, required for `policy.kind: recorded`) | `episodes` (per-seed summary, required), optional `rollouts` (gzipped per-decision `StepResult`s), `causal` (gzipped causal channels) | full `SessionBatch` checkpoint (every `EnvCheckpoint` + executors + accumulators) every `checkpointEveryDecisions` |
| `simforge.articulated-mujoco/v1` | none (workload is generated from params) | provider-listed `episodes.json` (required) and `scene-state.<seed>.json` | provider checkpoint copied on every `checkpoint` event; resumed with `--resume` |
| `simforge.gpu-batch-rollout/v1` | `scenario.input`, `map.topology`, optional `policy.actions` (JSON array of `EnvAction`, cycled) | `rollout.json` (required), `decisions.jsonl.gz` | provider `.npz` checkpoint every `checkpointEveryDecisions` |
| `simforge.policy-episodes/v1` | `episode.spec` (policy runner spec) | `episodes.json` (required), glob `trace.*.jsonl` (digest-chained per seed) | provider checkpoint every `checkpointEveryDecisions` |
| `simforge.render-bundle/v1` | `scene-state` (scene-state.v1 stream) | glob contract `frames/*/*/tick-*.<ext>`, `bundles.jsonl`, `results.json` (both required) | provider checkpoint `{nextTick}` every `checkpointEveryTicks` |
| `simforge.render-bundle-nurec/v1` | `scene-state`; params name scenesRoot/catalog/hoodDir/sourcePackages (sha256-pinned .usdz)/scene/rig/passes/ticks | same layout (`frames/*/*/tick-*.<png|npy>`, `bundles.jsonl`, `results.json`) | provider checkpoint every `checkpointEveryTicks` |

Foreign providers (`src/provider.rs`) run as one supervised child per attempt,
`<python> -m <module> job --params <params.json> --out-dir <dir> [--resume <checkpoint>]`,
with `<python>` = `$SIMFORGE_PROVIDER_PYTHON`, else the physical generation
selected by `<install-root>/venv` plus `bin/python`. The install root is
`$SIMFORGE_NATIVE_RUNTIME_ROOT` when explicit, otherwise the parent of the
running binary's `bin/` directory. Resolving the environment directory before
launch pins later imports to that immutable generation across reinstall; a
missing environment is an explicit error, not a global `python3` fallback.
`SIMFORGE_NATIVE_RUNTIME_STATE_ROOT` and the granted GPU indexes
(`CUDA_VISIBLE_DEVICES`) are exported to the child separately from the resolved
installed-asset root, which is forwarded for library and sky discovery. Protocol: stdout JSON
lines `progress` / `checkpoint{path}` / `done{artifacts[{relativePath,sha256,sizeBytes}]}`
/ `canceled`; stderr `{"event":"error",code,message}`; exit `0` done, `1` bad
params, `2` backend/capacity, `130` canceled after SIGTERM (the provider
checkpoints first). The runner re-hashes every listed artifact, copies each
announced checkpoint into its atomic store, and pins the provider's
`capabilities` report hash (dependency-only `--no-probe` form, except NuRec which must probe) in the execution identity so a solver,
kernel or renderer upgrade is a new identity. Providers: `simforge_oss_physics`
(`adapters/physics`), `simforge_oss_gpu` (`adapters/gpu`), `simforge_oss_gym`
(`adapters/gym`, PyO3 native runtime), `simforge_native`
(`renderer/service/python`); `simforge_splat` (`renderer/splat/python`, NuRec; admission refuses when its
`capabilities` reports `available: false`).

Output contracts may be globs (`"glob": true`, `*` within a segment, `**`
across segments) for tree-shaped outputs such as sensor frames; `required`
then means at least one match, and `expectedSha256` is not allowed.

Adding a workload means implementing `JobEngine` in `src/workloads/` and
registering it in `workloads::registry()`; the runner supplies resolved
inputs, coarse JSON params (parsed once at admission), a staging output
directory, the cancel token and an atomic checkpoint writer.
