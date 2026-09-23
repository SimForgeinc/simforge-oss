# Appearance streams: explicit research ablations (W5)

Appearance transfer is an **optional second sensor stream**, not new world state,
collision geometry, reward, metric authority, or an evaluation default. The
native Episode still owns every simulation/render barrier. `rgb` is retained
unchanged. A filter failure fails the run; there is no raw-as-enhanced fallback.

## Live REGEN

Install the adapter into an isolated Python environment, never over an installed
training wheel:

```sh
uv venv /tmp/simforge-appearance-venv
uv pip install --python /tmp/simforge-appearance-venv/bin/python \
  -r adapters/appearance/requirements.txt
# Supply compatible CUDA 12/cuDNN 9 shared libraries, or install ORT's extras:
uv pip install --python /tmp/simforge-appearance-venv/bin/python \
  'onnxruntime-gpu[cuda,cudnn]==1.24.4'
export SIMFORGE_APPEARANCE_PYTHON=/tmp/simforge-appearance-venv/bin/python

simforge drive run --policy scripted \
  --scenario scripts/bench/closed-loop/fixtures/corridor.episodes.json \
  --seed 42 --duration 20 --out runs/appearance \
  --enhance regen:/absolute/carla-cityscapes-512x384.onnx --record-controls
simforge drive verify runs/appearance/drive-corridor__scripted__seed42
simforge drive compose runs/appearance/drive-corridor__scripted__seed42 \
  --appearance --out runs/appearance/paired.mp4
```

Obtain **CARLA→Cityscapes** `latest_net_G.pth` from the
[upstream pretrained folder](https://drive.google.com/drive/folders/10z5Y12VK6l30T6mAD1zU-fPycaQ3rH3F).
Use upstream [`onnx_utils/regen_onnx_eport.py`](https://github.com/stefanos50/REGEN/blob/main/onnx_utils/regen_onnx_eport.py)
with `--height 384 --width 512` (and its `generator.py`) to export the model.
Retain the upstream revision, source/checkpoint/ONNX SHA-256s and export settings.
The filter checks the model's float32 NCHW shape against **each actual camera**;
there is no implicit resize. Export a matching model for a different rig.
The demonstrated 512×384 model does not support a 640×360 student rig.

Preprocessing follows the upstream ONNX example: RGB uint8 → contiguous NCHW
float32 in `[-1,1]`; output tanh values → clipped/truncated RGB uint8, alpha 255.
The server requires an active CUDA execution provider and refuses initialization
falling back to CPU. It loads no weights until explicitly launched. The renderer
and REGEN share the local GPU; announce use and keep at most one VLA resident.

`--enhance` alone **does not change the policy input**. Only
`--policy-input enhanced` switches the policy's retained RGB histories to the
second stream. HUD video stays raw. `--record-controls` separately records depth
and segmentation, even without REGEN. Neither flag changes dynamics or scoring.
A scripted/state-only policy has no visual input and therefore cannot measure a
policy-quality benefit from enhancement.

### Kernel/binding contract

Both existing JSON bindings accept this additive camera-channel field:

```jsonc
{
  "kind": "cameras",
  "rig": { "cameras": [/* ordinary CameraSpec entries */] },
  "passes": ["rgb", "depth", "seg"],
  "backend": { "kind": "service", "socket": "/dedicated-render.sock" },
  "enhance": {
    "socket": "/dedicated-appearance.sock",
    "identity": "regen-rgb-minus1-plus1-u8-v1:<onnx-sha256>"
  }
}
```

The bench launches `adapters/appearance/regen.py`, verifies its `READY` identity
and socket, then supplies this field. For direct bindings the caller launches
that server first. The optional hook is in the kernel camera path, **not** a
second TS/Python stepping loop. Native/Unix only; browser cameras remain refused.

For every `rgb` camera, the observation contains a second row with the same
`sensorId`, dimensions and simulation tick, `pass: "enhanced"`, and its own
`frame` descriptor. Consume `Episode.frame(id)` exactly as for raw frames; both
passes' leases must be released before advancing. Enhanced payloads are owned
native memory (descriptor `shm: ""`, offset zero), not renderer ring slots.
Never map that empty path: the binding's `FrameRef.buffer()` is the transport.
The existing Python `BevySensorRig` supports either pass without modification.

The socket protocol is `simforge.appearance-filter/v1`: little-endian uint32 JSON
header length, JSON header, then a raw RGBA payload of `header.bytes` bytes.
Requests carry the pinned identity, width/height, rowStride, tick and sensorId.
Responses must return the same identity/shape and exactly width×height×4 bytes.
Sockets are local trusted-process boundaries, not remote authentication APIs.
Timeout, bad length, changed identity or non-finite model output is an error.

Trace v2 `cameras.frames[]` contains **both payload CRC32 and SHA-256 digests**,
including their pass IDs. The reset options retain enhancement identity but omit
its ephemeral socket. Disabled enhancement is omitted entirely, not `null`.
Wall-clock `enhanceMs` is observation telemetry only and not a hash input. It is
included in realtime sensor/barrier cost, never used to advance offline world time.
GPU pixel nondeterminism remains visible; it is not normalized away.

### Files and temporal diagnostics

In addition to the ordinary run files:

- `frames/<sensor>/<index>.png`: unchanged raw RGB.
- `frames-enhanced/<sensor>/<index>.png`: separately generated RGB.
- `frames-depth/<sensor>/<index>.f32`: packed little-endian float32 reverse-Z,
  **not metres**; only when controls were requested.
- `frames-seg/<sensor>/<index>.png`: native resident CARLA-class-ID bytes in
  RGBA byte 2; these are labels, not a display-color image.
- `run.json.appearance`: ONNX path, content/preprocessing identity, explicit
  policy input selection. `passFrameDigests` seals each extra file; `controls`
  declares their encoding. `drive verify` checks all counts/digests and every
  trace raw/enhanced tick pair.
- `appearance-runtime.json`: actual ORT version, active providers and model shape.
- `appearance.jsonl`: per-render/per-sensor filter cost and normalized temporal
  mean absolute RGB differences for both streams. The first frame has no temporal
  difference. This log includes native terminal renders; the bench's saved PNG
  sequence instead includes its existing repeated warmup/first-policy handoff.
- `steps.jsonl[].appearance.filterMs`: kernel-measured per-camera round-trip
  producing the **pre-action** observation, including IPC. Policy latency remains
  a separately measured field.

Temporal L1 is `mean(abs(I[t]-I[t-1])) / 255`. It is a simple flicker diagnostic,
not LPIPS, optical-flow compensation, semantic consistency, or proof of
photorealism. Ego motion, object motion and tone/contrast changes also affect it.
Per-frame values are retained so summaries cannot conceal unstable intervals.
The network is stateless per frame and provides no temporal-consistency guarantee.

## Raw/enhanced policy ablation

```sh
simforge drive heat --policies auto-e2e --scenario scenario.episodes.json \
  --seed 42 --duration 20 --out runs/appearance-heat \
  --enhance regen:/absolute/carla-cityscapes-512x384.onnx
```

With enhancement, heat runs two **separate policy sessions** per policy,
sequentially: `raw/<runId>/` and `enhanced/<runId>/`. Both record both image
streams; only the policy-input selector differs. This avoids duplicate model
residency and run-directory overwrites. `heat-schedule.json` records each arm;
compose labels its policy-input choice. Score metrics are always computed from
native dynamics. A paired appearance compose repeats one episode visually but
counts its score only once in the aggregate.

`drive compose RUN --appearance` compares the two images of **one observation**;
`drive heat --enhance` compares **two closed-loop policy trajectories** that can
diverge. These are different claims. Use identical scenario/seed/prologue/replan
settings and report renderer nondeterminism. W4 evaluation remains raw unless an
explicit ablation chooses otherwise; enhanced images are never metric geometry.

## Offline Cosmos-Transfer2.5

Record native controls first. The offline command does not reconstruct missing
depth/labels from RGB and does not reuse REGEN images as Cosmos outputs:

```sh
simforge drive enhance runs/appearance/drive-corridor__scripted__seed42 \
  --cosmos --cosmos-root /absolute/cosmos-transfer2.5 --out datasets/cosmos-pair
# Preparation only, without a model/GPU claim:
simforge drive enhance RUN --cosmos --prepare-only --out datasets/cosmos-inputs
```

`adapters/appearance/cosmos.py` verifies source-file digests, excludes the authored
warmup, writes lossless RGB/control MP4s, freezes `cosmos-spec.json`,
`inputs.json` and `invocation.json`, then invokes the upstream
`examples/inference.py`. It uses native RGB as source, native depth and seg as
supplied `control_path`s, and an additional upstream edge control at weights
0.5/0.2/0.3. Depth is clip-wide normalized reverse-Z (near bright); no per-frame
normalization or unearned metric-depth claim. Class regions are visualized with a
frozen palette, **not relabelled as SAM2 instance masks or training-domain labels**.

An already installed, licensed/authenticated, fully cached runtime is required.
The pass is offline **postprocessing**, outside the simulation loop. It requests
cached loading with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`; these flags
are not a network sandbox for other upstream transports. It leaves upstream
guardrails enabled and records logs. On an idle multi-GPU allocation set
`CUDA_VISIBLE_DEVICES` and `SIMFORGE_COSMOS_NPROC`; the latter selects upstream
`torch.distributed.run`. Do not select busy GPUs or assume one 40 GB A100 meets
[upstream's 65.4 GB single-GPU requirement](https://github.com/nvidia-cosmos/cosmos-transfer2.5/blob/main/docs/inference.md).
Multicontrol loads all four control checkpoints, not only one edge checkpoint.

Only after a successful real inference and exact output count/shape/rate checks does
`paired-manifest.json` appear, with `{step, raw, enhanced, seg, depth}` and SHA-256s
for every pair. Output frame count/geometry/rate changes are refused, never repaired
by guessed trimming, duplication, resizing or retiming. No success manifest is written for
`--prepare-only`. Failure writes `blocker.json` with the literal invocation and
zero paired samples; generated logs/partial output are retained as failure evidence.

## Licence and domain boundaries

**REGEN pretrained weights and derivatives in this work are non-commercial,
research-only. Do not bundle them in SimForge releases or ship them as a product
feature.** The implementation adapter is separate from the externally supplied
checkpoint. REGEN is pix2pixHD-derived; its current
[root source licence](https://github.com/stefanos50/REGEN/blob/main/LICENSE)
contains BSD-style source notices. That source licence is **not** commercial
clearance for pretrained weights, Cityscapes/CARLA/EPE training targets, or their
redistribution. Keep those provenance/rights questions separate and obtain
explicit clearance before product use. Cosmos code, model and source-data terms
also require separate review; neither an available Dockerfile nor a download
credential constitutes that review.

The demonstration weights learned **CARLA→Cityscapes**, not Bevy→real. Bevy is an
out-of-training rendering domain. A plausible-looking frame can move boundaries,
erase hazards, change colours or hallucinate detail. Never train safety labels or
evaluate geometry from enhanced pixels.

## Recipe for a SimForge-domain REGEN (not executed)

1. Collect roughly 10–20k causally recorded Bevy frames with raw RGB, native
   depth/seg, rig/calibration and source digests. Split by map/site/episode, not
   adjacent frames; freeze held-out geography before target generation.
2. Produce structurally constrained **EPE or diffusion/Cosmos targets** offline
   for the same frames. Preserve original raw/controls and target-model revision,
   prompt, seed, transforms and licences. Reject missing/misaligned frames and
   inspect lane edges, signals, actor silhouettes and temporal transitions.
3. Train the upstream paired image-to-image generator with Bevy images as A and
   these target images as B. Keep independent train/validation/test clips; never
   add held-out evaluation targets to training. Pin resolution/preprocessing.
4. Export ONNX; check real PyTorch/ONNX pixel parity on held-out frames, benchmark
   filter cost and temporal L1/flow-aware consistency, then run the unchanged
   visual policy on raw and enhanced inputs as matched closed-loop arms.
5. Treat driving safety, model health, appearance fidelity and temporal stability
   as separate results. Promote neither a policy nor commercial usage from a
   subjective side-by-side video. This recipe has not been run here.

## Measured evidence — 2026-09-22

Evidence root: `~/simforge-assets/runs/drive/appearance-w5/`.
The small aggregate receipt is `verification.json`; per-frame measurements and
immutable run manifests remain beside the actual images/videos.

| Proof | Observed result |
| --- | --- |
| Live `final-live/drive-corridor__scripted__seed42` | 20 policy seconds, 200 decisions, two 512×384 cameras; 264 raw + 264 enhanced PNGs per camera, plus depth and seg |
| `drive verify` on that run | 528 raw file digests + 1,584 extra-pass digests verified; trace `c8038f54c71af5b9dbcff43b1aa53e14b7759f7abaac0fef4b9a377fa3accca1` |
| Default `raw-default/drive-corridor__scripted__seed42` | 200 decisions; 528 raw file digests verified; no enhancement option/metadata/extra pass |
| Raw/default vs enhancement-running, raw-policy input | All 200 poses, actions, native policy observations and applied controls agree exactly; both driving scores 1.0 |
| RGB reproducibility | All 528 raw PNG hashes differ across those fresh renderer runs. State parity is **not pixel parity** |
| `side-by-side.mp4` | 20 s, 1024×384, 10 FPS, labelled raw/enhanced panes; frame at 5 s visually inspected |
| Real AutoE2E two-arm heat | 10 policy decisions per arm, seven cameras × 74 raw/enhanced frames; each arm verified 518 raw + 518 enhanced digests; `policy-ablation/heat.mp4` |
| Native regression scope | Three camera tests pass, including both stream digests/leases and omission of `enhance` when disabled; no project-wide suite run |

The model is the actual pretrained CARLA→Cityscapes generator, exported with the
upstream opset-9 exporter. Checkpoint SHA-256:
`5cd2b97fbca4b743a4756bcc2a5bc53663e46260c3d32cb15c4bdcc8676c0d07`.
ONNX SHA-256:
`88b8faba73a340221e327a4ba32dbc3daf94eb8c98a752e4e1a756488a9780cb`.
It is retained outside the repository at
`~/simforge-assets/models/appearance-research/regen-carla-cityscapes/512x384.onnx`,
with `provenance.json`. Isolated combined N-API SHA-256:
`cca27c2d7b07b4ec762f0a2d392696f9f7b8833a11699bb077ade884c8215af6`
(`/tmp/simforge-appearance-native/node/`); no installed wheel was replaced.

### RTX 5080 cost and instability

ONNX Runtime 1.24.4, active CUDA provider, FP32, 512×384:

| Measurement | Samples | Mean | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| Per-camera model + preprocessing/postprocessing, after tick 0 | 526 | 12.789 ms | 12.771 ms | 13.180 ms |
| Per-camera kernel filter round-trip during policy decisions | 400 | 16.680 ms | 16.731 ms | 17.565 ms |
| Two-camera round-trip summed per policy step | 200 | 33.361 ms | 33.479 ms | 34.497 ms |

The latter includes IPC, host copies and temporal-diagnostic work; it is the
measured added sensor-path cost, not policy inference latency. **The first cold
filter call took 22.422 s** and is reported separately, not buried in a steady
median. The full enhanced run took 72.620 s wall time versus 33.157 s for the raw
default run, but the enhanced run also requested depth/seg, so subtracting those
totals would not isolate filter overhead.

| Sensor | Consecutive pairs | Raw temporal L1 mean | Enhanced temporal L1 mean | Ratio |
| --- | ---: | ---: | ---: | ---: |
| Front wide 120° | 263 | 0.002562 | 0.016616 | 6.49× |
| Front tele 30° | 263 | 0.002320 | 0.010449 | 4.50× |

These increased differences are consistent with substantial temporal instability,
but are not a motion/contrast-controlled estimate of flicker. The inspected frame
shows a darker/greener road and grass, a strongly altered sky and softer details;
it establishes a real transformation, **not improved realism or hazard fidelity**.
AutoE2E's short smoke scores were 0.765379 (raw) and 0.759649 (enhanced).
Ten decisions on one benign corridor are a plumbing ablation, not a statistical
policy-quality result or promotion comparison.

### Cosmos outcome: prepared controls, blocked inference

`cosmos/inputs.json` contains **200 verified raw/depth/seg triples from the real
20 s recording**, and `cosmos/{rgb,depth,seg}.mp4` are 512×384 at 10 FPS.
Depth/seg frames were visually inspected; native semantic class regions include
speckled boundaries and are not validated training targets. No
`paired-manifest.json` or Cosmos-enhanced frame is claimed: **0 generated pairs**.

The actual `drive enhance --cosmos` command prepared these inputs and exited 2
with `cosmos/blocker.json` because the selected Cosmos checkout/interpreter was
absent. The requested remote investigation is recorded separately in
`cosmos-host-blocker.json`:

- On `simforge1`, `~/cosmos` is empty; `~/cosmos-worker` contains deployment
  source and historical logs, not a runnable checkout. Its hard-coded
  `/workspace/cosmos-transfer2.5/.venv/bin/python ... --help` fails with exit 127.
- Its expected `/runpod-volume` is absent. The three inspected HuggingFace cache
  roots lack Transfer2.5, Predict2.5 and Guardrail1 weights. Embed stubs and
  Reason2 metadata are not the required stack.
- The local `ghcr.io/simforgeinc/cosmos-worker:latest` image is absent. Registry
  inspection of both `latest` and the exact historical pushed digest
  `sha256:2206cbdea67144cb7463cb6c9332f9a64a6570d976fea876374637e5a649291f`
  returns `manifest unknown`. The historical worker was edge-only, not the
  requested multicontrol path.

Unblocking requires an accessible pinned runtime/image, authorized complete
weights and a validated idle multi-A100 configuration. No remote GPU was
allocated and no inference, sample quality or 50-frame Cosmos success is claimed.
