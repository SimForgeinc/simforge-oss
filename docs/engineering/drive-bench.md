# SimForge drive bench

The drive bench is a caller of the native kernel `Episode`. The kernel owns
world time, authored warm-up, inference barriers, deadline/fallback decisions,
camera scene assembly and rendering, and trace/result-core production. The
runner owns policy services, observation adaptation, frame/HUD evidence and
the scored result manifest.
There is no Studio/web UI in this path.

## Commands

From the repository (or an installed CLI):

```sh
simforge drive run --policy scripted \
  --scenario examples/edge-cases/01-construction-chicane-reversing-truck/scenario.instance.json \
  --seed 42 --duration 10 --out ~/simforge-assets/runs/drive

simforge drive run --policy alpamayo-1.5 --scenario scenario.instance.json \
  --seed 42 --duration 10 --out ~/simforge-assets/runs/drive --quant nf4

simforge drive run --policy scripted --scenario campaign.episodes.json \
  --seed 42 --duration 10 --out ~/simforge-assets/runs/drive

simforge drive heat --policies alpamayo-1.5,qwen-drive,jev,auto-e2e \
  --scenario scenario.instance.json --seed 42 --duration 10 \
  --out ~/simforge-assets/runs/drive
simforge drive compose RUN_A RUN_B RUN_C RUN_D --out heat.mp4
simforge drive compose RUN_A --out solo/drive.mp4
simforge drive verify RUN_A
```

`--scenario` accepts one concrete instance or an `episodes.json` document; the
first `instances[]` entry is selected. A positional scenario is accepted as a
convenience for `drive run`. `--out` is a root: the runner creates
`<scenarioId>__<policyId>__seed<seed>/` below it. The default is
`~/simforge-assets/runs/drive`.

The default timing mode is `offline-simtime`. The engine waits at each policy
barrier, so wall-clock inference time does not alter the episode. Add
`--realtime --deadline-ms N` to use a wall-clock deadline. The kernel measures
observation-to-action elapsed time (including adapter work and camera rendering),
not the policy's separately reported `latencyMs`. Strictly exceeding N applies
the documented `zero-control` fallback; equality is on time. A deadline without
`--realtime`, or realtime without a positive deadline, is rejected.

`--live` starts `ffplay -f rawvideo` for the main camera (`SIMFORGE_FFPLAY_BINARY`
can override the executable). `--no-start-renderer` and `--no-start-model` are
for an already-running local endpoint and are not a substitute for a rendered
camera source. Every model camera frame comes from the kernel `cameras` channel,
backed by `renderer/target/release/native-render-service`; the CLI does not
construct per-tick scene documents or issue render RPCs.

Socket policies start their adapter's `run_server.sh` through one shared helper
(`drive/model-socket.ts` `openModelEndpoint`: spawn, wait for the Unix socket,
connect, `hello`, and SIGTERM/SIGKILL on stop). `--model-socket` defaults to a
per-run `${tmpdir}/simforge-drive-<policy>-<pid>.sock`, so the concurrent heat
group never unlinks another run's endpoint; `--no-start-model` therefore needs
an explicit `--model-socket`. Policy ids name the bench entry, `run.json.model.
family` names what the endpoint reported: `alpamayo-1.5` → `alpamayo-1.5`,
`qwen-drive` → `qwen-drive-1.0`, `auto-e2e` → `auto-e2e`, `jev` and `scripted`
report no family and keep their policy id. Camera-profile names (`alpamayo-2cam`,
`qwen-drive-3cam`, `auto-e2e-6view`) are persisted in `run.json` and checked by
`verify`, so they are not renamed for consistency.

The default native world is a **140 m route-radius subset** of the installed
`map-bundles/<mapId>/3d` manifest, including static road and vegetation layers.
The runner reuses `adapters/jev-driver/select_tiles.py`: it verifies the
`textures-512-bc7` tier, substitutes its texture objects, decodes meshopt and
dequantizes the selected GLBs into the map's `.corpus/<mapId>/drive-bc7` cache.
This preparation requires Python 3 and the glTF Transform CLI used by that
helper. Whole-map masters and raw compressed bundle tiles are not the default
service inputs. `--native-world` is an explicit override for an already-prepared
GLTF/GLB or directory of prepared meshes.

Renderer startup uses the shared native-service process helper, which waits for
the service's atomic `--ready-file` record, checks protocol 5, then completes
the `hello` handshake. A socket file alone is not readiness. Source-built
renderers need the pinned sky plates; run `node scripts/native-runtime/prepare-sky.mjs`
or set `SIMFORGE_SKY_ASSETS` to an installed runtime's `share/sky` directory.
The scene uses cinematic lighting resolved from the scenario's weather and
time of day, with automatic camera metering.
For `--no-start-renderer`, set `SIMFORGE_NATIVE_RENDER_SOCKET` to the existing
service endpoint.

Existing comparison policies receive the same **64-frame native prologue at
10 Hz** (or more if required). The world advances under its authored controller
during this prologue; `--duration` and the decision budget apply afterward.
Ego history has distinct simulation timestamps, keeping existing heat policies
at the same decision start. A policy may explicitly declare `egoHistorySteps`;
the state-only PPO teacher declares zero and receives one real display frame
at reset, with no authored-controller advance before its first action. Thus a
teacher clip is not automatically a starting-state-matched visual-model heat.

## Run directory

A successful run has this layout:

```
<root>/<scenarioId>__<policyId>__seed<N>/
  run.json                 resolved scenario, map, seed, policy/model, timing, git sha
  frames/<sensorId>/<n>.png native RGB frames (PNG, one per render tick)
  steps.jsonl              one policy decision row, including HUD/model telemetry
  trace.jsonl              simforge.episode-trace/v2 kernel evidence + digest chain
  score.json               simforge.eval-score/v1 driving metrics
  drive.mp4                HUD-composited main-camera video
  result.json              simforge.eval-result-manifest/v1 (written last, atomically)
  log.txt                  renderer/model lifecycle and errors
```

`frames/<sensorId>` has `warmupFrames + steps` files. `run.json.frameDigests`
contains a SHA-256 for each PNG. `steps.jsonl` rows contain
`{step,tS,pose,action,reasoning,trajectory,latencyMs,deadlineMs,miss,applied,crossTrackM,extras}`;
`crossTrackM` is the runner's signed lateral offset (metres, left positive) from
the post-action pose to the route centerline, and `extras` is the policy's own
telemetry (`fallbackReason` and `latched` are the two keys the runner, `verify`
and the showreel tooling read; the rest is model-specific).
The result manifest is the completion marker; it lists digests and byte sizes
for the durable evidence. Rerunning the same identity removes the previous
completion marker and frame set before recording new evidence. The renderer
and model are stopped before the log is sealed into the manifest.
`simforge drive verify` validates the manifest, required evidence, artifact
digests, frame count/digests, contiguous steps, the trace digest chain and the
model-health decision count. It refuses a missing or invalid result rather
than reporting a clean run. Model-declared safety fallbacks are counted in
`modelHealth.fallbacks.closedLoop`, separately from the deadline-miss count.

`Episode.finish()` supplies completion status, timing, decision counts and the
episode digest; the runner adds scoring, model health and artifact inventory.
An early/partial kernel completion is never relabelled as a successful run.

Trace v2 hashes reset, all authored warm-up rows, and policy rows. Remove each
row's `digest`/`timing`, set `dl.el` to null, then SHA-256 the previous hexadecimal
digest plus the engine's canonical JSON. The final `episode_digest`/`summary`
record seals the chain without adding another hash input. Camera scene/frame
digests belong to kernel evidence; PNG digests remain in `run.json`. Wall-clock
telemetry does not change deterministic identity. Renderer pixel nondeterminism,
when present, is visible in those camera digests rather than masked.

This is intentionally a new trace identity, not the old insertion-ordered TS
chain (which included latency). The scorer verifies v2, excludes warm-up from
policy metrics, and rebases the scoring reset to the last warm-up observation.
`compose` continues to read old `run.json`/`steps.jsonl`/PNG run directories;
`verify` also retains the old trace-chain reader. No old trace is rewritten.

Manifest validity and model-health qualification are distinct. The writer and
verifier share the same health rule: closed-loop fallbacks or invalid plans make
the run exploratory and non-promotable. Missing health also prevents promotion.
Clean model health is not a driving-safety or held-out-evaluation qualification.

Scoring reuses `@simforge-oss/evaluation`'s `scoreEpisode` implementation after
its v2 scoring projection, without rewriting kernel evidence, and keeps
unavailable metrics explicitly unavailable. `drivingScore` is route completion
multiplied by infraction penalty factors. The trace and score carry
`offline-simtime` or `realtime`; consumers must not relabel an offline run as
real time.

## Policy interface

Policies implement `packages/cli/src/commands/drive/policy.ts`:

```ts
interface Policy {
  readonly id: string;
  readonly cameraProfile: string; // profiles.ts key, or 'none'
  readonly historyFrames: number;
  readonly egoHistorySteps?: number; // default 64; state-only teacher declares 0
  readonly obsPreset?: 'visible'; // kernel LOS filtering before the object cap
  start(ctx: { mapId: string; graph: LaneGraph; out: string; log: (line: string) => void }): Promise<{ hello: unknown }>;
  act(obs: PolicyObservation, seed: number): Promise<PolicyDecision>;
  stop(): Promise<void>;
}
```

`PolicyObservation` contains the native actor snapshot with the ego row's
`egoId`, ego pose and oldest-to-newest ego history (64 entries once warm for the
default visual-policy prologue), RGB histories by sensor (only for policies with
`historyFrames > 0`), `frameSize`, the lane-graph route ahead in world
coordinates (always at least two points: the authored route while it has road
left, otherwise the nearest lane), `mapId`, the loaded `LaneGraph`, and
`nativeObservation` with the exact native state vector, perceived object rows,
and per-approach current signal state (schema in `docs/policy-step.md`).
Trajectory policies share `policies/trajectory.ts`: ego-frame samples become a
timed plan, are anchored at the current pose, and `followPlan` steers toward the
first sample at or beyond 0.35 s with per-policy speed/acceleration limits. `PolicyDecision` returns an `EnvAction`, a reasoning record,
an optional world-frame `[x,y]` trajectory for the HUD, measured latency, and
model-specific extras.

The reasoning schema is intentionally typed and machine-readable:

```ts
type ReasoningRecord =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; question: string; choice: string;
      probabilities: Record<string, number>; confidence: number | null;
      candidates: string[] }
  | { kind: 'none' };
```

The HUD renders bars only for reported finite probabilities. When a deterministic
safety envelope forces a single candidate or a service fallback returns no
distribution, the choice remains visible and probabilities are labelled
unavailable; absent values are never presented as measured 0% probabilities.

`scripted` is the deterministic reference driver and follows the native authored
route with a speed setpoint; it is not a zero-control placeholder.
`alpamayo-1.5` uses the length-prefixed MessagePack Unix-socket endpoint started
by `adapters/alpamayo/scripts/run_server.sh`. Qwen-Drive and AutoE2E use the
same socket framing through their policy modules. Jev is text-only and uses
`cameraProfile: 'none'`, but the bench still renders the main camera for video.
Jev's selected trajectory is anchored at issuance and tracked at every 10 Hz
engine barrier while the 3 Hz decision is held. The preview advances through
the timestamped plan; holding a maneuver never means repeatedly steering toward
its already-passed first waypoint. This execution does not change Jev's
candidate generation, choice distribution, or deterministic safety envelope.
The bench launches Qwen-Drive in reasoning mode so its text is available in
the HUD. The Alpamayo adapter receives its required 16 ego-frame XYZ poses,
rotations and relative timestamps; AutoE2E retains 64 ego samples but sends
only the current real image in each of its six positional camera slots.
Jev's scene-v2 decision state includes native signal phase/countdown rows.
AutoE2E rasterizes graph-sampled signal approaches and stop lines into its
existing binary static channels; phase/countdown metadata remains explicit
and is not encoded using invented checkpoint semantics.

`torch:<run>/<update>` resolves a SHA-256-verified `simforge-policy` entry from
the model store. `torch:/absolute/path/checkpoint.pt` remains available for
teacher checkpoints. The generic `simforge_oss_gym.train.serve` endpoint serves
`simforge.ppo-teacher/v1` setpoints and `simforge.distill-student/v1` controls;
camera students require a typed store ref before the rig is constructed.
Inference defaults to CPU (`SIMFORGE_TORCH_PYTHON` selects an isolated Python);
do not hide the GPU from the parent bench, which must still render with Bevy.
The teacher selects the kernel `visible` channel, filtering occluded rows
before the 64-object cap exactly as training does. Its encoder additionally
ignores privileged position/nearest-range slots. The student's neural inputs are RGB,
speed/yaw-rate and ego-frame navigation only; its connection-local GRU state
never crosses sessions. `student-front` is one native 640×360 camera with its
own camera id, distinct from the display cameras. HUD text is checkpoint
telemetry, not language reasoning. Neither recipe is promotion-qualified.
See [W3 commands and limitations](closed-loop-training.md#w3--trainer-and-policy-servers).

Endpoint `hello.protocol` negotiates `simforge.policy-endpoint/v3`; an
unadvertised/v2 endpoint still receives the original v2 request. V3 adds
calibration/exposure/resize metadata, timestamped ego and route anchors,
plan identity/horizon/adoption tick, and explicit fallback health. Plans are
checked against the current simulation barrier; a held plan is not counted
as a new genuine plan or mistaken for fallback. Jev now uses the same
MessagePack socket in the bench; its explicit HTTP service remains available.
`run.json.model.protocol` records what was negotiated.

The shared [qualification tool](../../tools/policy-qualify/qualify.py) produces
`simforge.policy-qualification/v1` receipts from real recorded input fixtures.
`SIMFORGE_POLICY_QUALIFICATION=/path/receipt.json` checks model/checkpoint
identity and freezes the complete receipt in `run.json.model.qualification`
at startup. Absence stays null, never an implied pass.

New `steps.jsonl` rows also retain pre-action `observation` (native state,
object rows, pose, route and motion) and native `appliedControl`.
These are **training/evidence channels**, not extra student model features.
The latter is the actual final physics-substep actuator input, also hashed in
trace v2. Distillation verifies these labels, exact teacher replay and frame
digests; old setpoint-only runs cannot silently become control datasets.

Camera rigs have one source:
`adapters/gym/simforge_oss_gym/camera_profiles.json`, imported by the typed
`drive/profiles.ts` view and Python Episode presets. A policy owner adds a
profile there (sensor/camera ids, mounts, yaw/HFOV and resolution); synthetic
frames are prohibited.

The resolved rig is passed to `Episode` with the display cameras. Returned
`FrameRef` buffers are zero-copy shared-memory leases: the runner encodes PNG/HUD
evidence and copies only the RGB histories policies retain, then explicitly
releases the leases before advancing. `reset(onFrame)` delivers each real
warm-up observation/snapshot from the kernel; its synchronous callback copies
pixels needed by asynchronous encoding and releases them before the next tick.
The callback never advances or renders a world.

### Model BEV inset (`extras.bev`)

Opt in to Qwen-Drive's **real perception head**, sharing the planner's resident
VLM, with `SIMFORGE_QWEN_BEV=1 simforge drive run ...` or the same environment
variable on `drive heat`. A manually started Qwen server takes `--bev`.
Without the flag the perception head is not loaded or run. The VLM may remain
NF4; the perception head is always bf16 and is moved to the device **before**
`QwenDrivePerception.attach(planner.vlm, processor)` so attachment never
requantizes or copies the backbone.
During perception only, scoped VLM hooks request just one unused vocabulary
logit (`logits_to_keep=1`) and retain only the final decoder state that the
head consumes. They are removed in `finally` before subsequent planning.
This avoids retaining unused language outputs through voxel pooling without
changing the feature tensors, head precision, input views or output grids.

The optional head needs `perception/config.json` and
`perception/model.safetensors` alongside the planner weights (500,368,384 bytes
for the head checkpoint). A planner-only installation can fetch the exact
same pinned release without replacing its VLM:

```sh
adapters/qwen-drive/.venv/bin/hf download Qwen/Qwen-Drive-1.0-4B \
  perception/config.json perception/model.safetensors \
  --revision 28484089a7cc8c335cf5089fb0745cf7c49b6eaa \
  --local-dir ~/simforge-assets/models/qwen-drive/28484089a7cc8c335cf5089fb0745cf7c49b6eaa
```

The pinned perception checkpoint SHA-256 is
`e964ca945f028bbbfadfdf9c1e47d31cfc3fe502d205eca0bb5a3d2c5ab450ae`.

Perception consumes the exact current image of each of the planner's three
camera histories, not additional renders, ground truth, or generated views.
The upstream single-frame processor resizes those images to 896×512 for an
additional VLM forward with the trained perception prompt. It shares weights,
not the planner's differently arranged/resized history-token features. Camera
intrinsics and optical-camera-to-ego transforms are derived from the native
rig's actual HFOV, resolution, mount and orientation; the projection includes
the resize. Missing calibration is an error, never an identity-camera fallback.
Two upstream CUDA kernels compile on first use, requiring `nvcc`/`CUDA_HOME`
compatible with the adapter's torch build.

**Coverage limitation:** the released perception weights were trained on
six-camera nuScenes and eight-camera OpenScene/nuPlan rigs, not the bench's
three forward cameras. The head accepts the actual camera count and produces
detections, semantic occupancy and map segmentation from these available
views, but this is an out-of-training rig and rear views are unobserved.
The inset explicitly labels this limitation. These are model predictions,
not validated geometry or ground truth. No GT actors are drawn. The upstream
`nuscenes` metadata value selects its 80×80 m occupancy-range preset; it does
not claim that the input is a nuScenes sample.

Any policy can return the following JSON-compatible object as `extras.bev`.
`hud.ts` renders the same inset for solo video and compose/heat panes:

```ts
{
  schema: 'simforge.bev/v1',
  source: 'model/head identity',
  frame: 'ego-x-forward-y-left', // metres; yaw CCW from +X
  viewExtentM: [0, -20, 40, 20], // [xmin, ymin, xmax, ymax] displayed
  map: { // occupancy has the same optional raster structure
    encoding: 'rle-u8',
    width: 64, height: 128, // each axis <= 128
    extentM: [-30, -15, 30, 15],
    resolutionM: [0.46875, 0.46875], // [row/X, column/Y] metres/cell
    classes: ['background', 'driveable_surface', 'road_line',
              'road_edge', 'crosswalk', 'walkway'],
    palette: ['#fafafa', '#c4cdd6', '#ffc107',
              '#e15f41', '#4bb4aa', '#8bc34a'],
    data: /* [classIndex, runLength, ...], runs cover width*height cells */
  },
  detections: /* [[x, y, yaw, lengthAlongHeading, width, classIndex, score], ...] */,
  detectionClasses: /* class names in index order */,
  trajectory: /* optional planned ego-frame [[x,y], ...], overlaid in yellow */,
  observationTS: /* simulation timestamp of the input images */,
}
```

Rasters are row-major: row 0 is the **maximum-X/forward** edge, column 0 is
the **maximum-Y/left** edge. Qwen's 200×400 map raster is transposed/reversed
to that convention and nearest-sampled to 64×128; its 200×200×16 occupancy
is projected to 2D using the highest non-background/non-empty semantic voxel,
otherwise the highest background voxel, otherwise empty, then sampled to
128×128. Nearest sampling never invents an intermediate class but can lose
small/thin features. The inset shows map classes, semantic obstacle occupancy
and orange detection outlines at score ≥0.25, with a tiny legend, metre grid,
cyan ego marker at bottom centre and the planned trajectory. The full grids
remain in `steps.jsonl`, including areas outside the forward display crop.
Malformed grids or unsupported coordinate schemas fail visibly rather than
silently displaying plausible but incorrect perception.

Qwen also records `inputFrameDigests` (camera id, wire encoding, SHA-256 of each
current input frame), `coverage`, `cameraIds`, `occupancyProjection` and the
detection threshold. With the bench's raw RGB wire, the input hashes can be
checked against decoded `frames/<sensorId>/<warmupFrames + step>.png` RGB
bytes. Both solo video and compose annotate the decision's **input frame**;
the post-action `steps.jsonl.pose` is not used to re-anchor an ego-frame BEV.
Server `hello.bev`, `hello.perceptionPrecision`, `hello.plannerVram` and
`hello.vram` record residency, while each step reports `timings.modelMs`,
`timings.perceptionMs`, `timings.totalMs` and CUDA allocated/peak/reserved VRAM.
The model hello also records host, accelerator, torch and CUDA versions, so an
SSH-forwarded A100 run is not mistaken for local RTX inference. On a contested
16 GiB GPU, voxel-pooling's transient memory can exceed available headroom
even when the resident weights fit; do not solve an OOM by dropping cameras,
reducing head precision or substituting ground-truth grids.

`run.json.model.hello.inputRevision` is
`simforge-qwen-input/v2-derived-acceleration`: the policy no longer overrides
the server's history-derived acceleration with a fabricated `[0,0]`.
This correctness fix applies with BEV on or off; older Qwen runs with the
zero-acceleration override are not input-equivalent. The planner inference,
weights and camera-history path otherwise remain unchanged when BEV is off.

## VRAM and model residency

The local RTX 5080 has 16 GiB and the Bevy renderer consumes several GiB. **At
most one VLA (Alpamayo or Qwen-Drive) may be resident on the local GPU.** Before
starting either VLA, announce the load on the bench hub and inspect `nvidia-smi`;
release it before starting the other. AutoE2E (about 0.42 GiB) and Jev (cloud
API, 0 GiB) may co-reside with a VLA. `drive heat` enforces VLA-exclusive
scheduling from the registry's `policyGpuClass` (`alpamayo-1.5` and `qwen-drive`
are `exclusive`; everything else, including `torch:<checkpoint>`, is `shared`
and runs concurrently first). If a VLA cannot fit locally,
use a remote Unix-socket server through an SSH forward and record that fact in
`run.json`/`log.txt` rather than silently running a different input path.

Model provenance, checkpoint/revision, camera profile, quantization, seed and
runtime git identity belong in `run.json` and the manifest provenance. The
runner retains the model server's `hello` and uses its reported quantization,
revision and checkpoint digest; the global `--quant nf4` request must not
relabel an AutoE2E FP32 model or a cloud/scripted policy. Unreported fields stay
null. A seed is not a cross-device reproducibility claim; model determinism is
scoped to the same host and device.

## Episode caller cutover evidence (2026-09-22)

The corridor fixture `scripts/bench/closed-loop/fixtures/corridor.episodes.json`,
seed 42, was run for 2 policy seconds before and after the cutover, after the
same 64-frame authored prologue:

| Policy | Before and after driving score | Evidence |
| --- | ---: | --- |
| scripted | 0.834841456986247 | Entire `score.json`, poses/actions and deterministic state agree exactly |
| jev | 0.8653593618826072 | Entire `score.json`, poses/actions and deterministic state agree exactly |

`/tmp/simforge-drive-phaseb/drive-parity.json` records these checks and both
successful v2 verifications. `run.json`, `result.json` and decision-row key sets
are unchanged. State comparison normalizes the old TS trace's numeric-key
`Float64Array` JSON into an array; no numeric tolerance is used. State-only
recorded-action replay also passed (`state-parity.json`). Raw old/v2 trace
digests are not interchangeable.

Additional real-runtime proofs under that evidence root:

- `after/drive-corridor__auto-e2e__seed42`: 20 real model decisions, 84 frames
  per recorded sensor, 588 PNG digests verified, clean model health.
- `heat/`: scripted/Jev/AutoE2E heat and three-pane compose succeeded; all
  three manifests, frame inventories and v2 chains passed `drive verify`.
  Jev's first cloud call took 513.501 ms and hit its **model-side** deadline,
  producing four held fallback decisions. That heat run is correctly
  exploratory/non-promotable; this is not hidden as clean health or a kernel
  offline deadline miss. The solo Jev parity runs were clean.
- `live-realtime/`: actual `ffplay` under Xvfb, four decisions with a 1 ms
  kernel deadline, all four correctly recorded as `zero-control` misses.
  `realtime-on-time/`: two decisions with a 10,000 ms deadline, no misses.
- `alpamayo/`: the real Alpamayo-1.5 NF4 endpoint completed two decisions and
  passed verification with clean model health.
- `legacy-compose.mp4`: both pre-cutover run directories remain composable.

The superseded 113-line TS render/warm-up/decision/trace block, four-line TS
trace hasher, and 37-line scene/camera assembler were removed (154 legacy
implementation lines, not a net-file-size claim). The remaining iteration is
only policy invocation, `Episode.step`, and evidence adaptation.

Camera identity is deliberately not advertised as bit-reproducible RGB:
the separate 10 s two-camera binding proof found 0/101 scene-document
mismatches but 202/202 RGB hash mismatches across renderer resets/processes.
Both raw frame identities remain in their v2 traces
(`/tmp/simforge-episode-cameras/service-parity/camera-parity.json`).
