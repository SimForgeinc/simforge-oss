# @simforge-oss/alpamayo-runtime

Locally runnable inference services for **all three Alpamayo generations**,
behind one wire and one engine interface:

| Family | Checkpoint | Cameras | Extras | Local execution |
| --- | --- | --- | --- | --- |
| `alpamayo-1` | `nvidia/Alpamayo-R1-10B` | exactly `[0,1,2,6]` | — | BF16 ≥24 GiB; NF4/FP8 wired but **unmeasured** |
| `alpamayo-1.5` | `nvidia/Alpamayo-1.5-10B` | variable, default `[0,1,2,6]` | nav conditioning, VQA | BF16 ≥24 GiB, NF4 ≥12 GiB, FP8 ≥16 GiB |
| `alpamayo-2-super` | `nvidia/Alpamayo2-Super` | exactly `[0,1,2,3,5,6]`, VQA `[0,1,2,3,4,5]` | VQA, meta-actions, auto-labeling, grounding | **not qualified** — 80 GiB class, NVIDIA tested only H100 |

Every pin — weights revision, upstream code commit, sidecar repos — is
declared once in [`src/simforge_alpamayo/families.py`](./src/simforge_alpamayo/families.py)
and mirrored with per-file digests in `packages/model-store/models.lock.json`.
`tests/test_families.py` fails if the two disagree, so the product can never
describe one checkpoint while the installer materializes another.

No weights, caches or environments live in this repository. Installs go to
`${SIMFORGE_ASSETS_ROOT:-~/simforge-assets}/models/<family>/<revision>/` and
the shared Hugging Face blob cache to `.../hf-cache` (`HF_HOME`).

## One process, one family, two transports

The three upstream packages (`alpamayo_r1`, `alpamayo1_5`, `alpamayo2_super`)
pin mutually incompatible dependency sets, so **each family gets its own
virtual environment** and a process serves exactly one `(family, quant)`.

Both transports are served by the *same resident engine*, which is the whole
point: a second process would load another 22–72 GB of weights.

- **unix socket, length-prefixed MessagePack** — closed loop. Raw
  multi-camera frames are tens of megabytes per step and shared-memory
  bundles never cross HTTP.
- **HTTP facade** (`--http`) — open loop. `POST /invoke`, `POST /text`,
  `GET /healthz`. Exists so the existing `http-json` model-run executor works
  without learning MessagePack.
- **In-process batch** (`simforge_alpamayo.batch`) — a cloud worker that
  wants no HTTP hop at all.

All three funnel through `simforge_alpamayo.invoke.handle_item`, so they
cannot disagree about validation, refusal codes or provenance.

## Install

The product path, with digest verification, resumable downloads and the
licence/token flow:

```bash
simforge models list                                  # catalog + what this machine can run
simforge models preflight --family alpamayo-1.5       # hardware/driver/disk verdict
simforge models install alpamayo-1.5 --quant nf4 --accept-license --wait
simforge models verify alpamayo-1.5 --deep            # re-hash every shard
simforge models uninstall alpamayo-1.5
```

The development path (vendored upstream checkout + venv, no digest
verification):

```bash
scripts/setup.sh --family alpamayo-1.5            # sidecars only
scripts/setup.sh --family alpamayo-1.5 --weights  # + ~22 GB of weights
```

`nvidia/Cosmos-Reason2-8B` (Alpamayo 1.5's config/tokenizer sidecar) is
`gated: auto`, so it needs `hf auth login` for the development path or a
token in the OS credential vault for the product path. It is the **only**
gated dependency across the three families: Alpamayo 1 uses ungated Qwen
sidecars and Alpamayo 2 Super is self-contained.

## Run

```bash
scripts/run_server.sh --family alpamayo-1.5 --quant nf4 \
    --socket /tmp/simforge-alpamayo.sock --http 127.0.0.1:9310 --warmup-cams 4

# smoke test from another shell (synthetic input: proves the wire, not accuracy)
PYTHONPATH=src vendor/alpamayo1.5/.venv/bin/python -m simforge_alpamayo.client \
    --socket /tmp/simforge-alpamayo.sock --seed 42
```

The server prints `READY <socket> {json}` on stdout once the engine is loaded
and every transport is bound; the JSON tail carries the resolved HTTP port and
the verified checkpoint digest. Checkpoint identity is asserted **before** the
weights are read, so a wrong revision fails on a metadata read rather than
after a multi-minute load.

## Wire protocol (`simforge.policy-endpoint/v2`)

`[uint32 LE length][msgpack]` frames. Ops: `hello`, `health`, `capabilities`,
`warmup {cams}`, `act {obs, seed, params}`, `text {obs, prompt, task, params}`,
`reset`, `close`, `shutdown`.

```jsonc
{
  "op": "act",
  "seed": 42,                       // seeds VLM sampling AND diffusion noise
  "obs": {
    "cameras": [{
      "camera_id": 1,               // 0..6, upstream CAMERA_NAMES_TO_INDICES
      "frames": ["<bytes>", ...],   // exactly 4, oldest -> newest (t0 last)
      "encoding": "raw",            // raw | raw-b64 | jpeg | png
      "width": 512, "height": 384   // required for raw encodings
      // or: "frames_paths": ["/abs/path", ...] — absolute only, no URLs
    }],
    "ego_history_xyz": [[x,y,z], ...],       // 16 @10 Hz, ego frame at t0
    "ego_history_rot": [[[...3x3...]], ...], // optional, default identity
    "ego_history_t_s": [ ... ],              // optional; validated, never resampled
    "nav_text": null                         // 1.5/2 only; refused on A1
  },
  "params": {"top_p": 0.98, "temperature": 0.6, "num_traj_samples": 1,
             "max_generation_length": 256, "num_diffusion_steps": null}
}
```

`act` response `result`: `trajectories` = `num_traj_samples × 64 × [x,y,z]`
(6.4 s @10 Hz, FLU ego frame at t0), `trajectory_rot`, `reasoning`
(chain-of-causation per sample), `timings`, `vram`, `rng_provenance` and
`model` identity.

### What is refused, and why that matters

An observation that does not satisfy the family's real input contract is
**refused with the exact missing field or required camera set** — never
padded, cropped, resampled or silently accepted. A refusal is `ok: false` in
a 200-shaped response, so one bad clip in a 64-item manifest does not fail
the other 63.

| Code | Cause |
| --- | --- |
| `camera_set_invalid` | camera set violates the family/task profile (`required_cameras` names the correct set) |
| `missing_fields` | absent `cameras`, `ego_history_xyz`, `prompt`, or an auto-labeling future (`fields` lists them) |
| `unsupported_op` | `text` on Alpamayo 1, or `nav_text` on a family without navigation conditioning |
| `input_error` | wrong history length, non-finite poses, non-monotonic timestamps, byte count vs declared size, mixed frame sizes, relative paths |

A quantization mode with no measured envelope loads but stamps
`qualification: "pending"` into every result's `rng_provenance`, so an
Alpamayo 1 NF4 number can never be read as a measurement that was never made.

## Quantization

Load-time, reproducible from the recipe — no serialized artifact.

| Mode | Tooling | Quantized | Kept BF16 |
| --- | --- | --- | --- |
| `bf16` | none | — | everything |
| `nf4` | bitsandbytes 4-bit NF4, double-quant, bf16 compute | every `nn.Linear` in the VLM backbone **and** the 2.3B action expert | vision tower, `embed_tokens`, `lm_head`, action in/out projections, diffusion head |
| `fp8` | torchao `Float8WeightOnlyConfig` (e4m3) | same, plus the vision tower | `lm_head`, embeddings, action projections, diffusion head |

Quantization changes **behaviour**, not only numerics: an NF4 score is never
comparable to a BF16 baseline without its quant label, which is why `quant`
is part of the recorded model identity.

AWQ was evaluated and rejected: autoawq has no support for these custom
architectures, and calibration would need the gated driving dataset. Alpamayo
2 Super has no quantized recipe at all — offering one would be a guess.

## Camera-rig bridge (frame bundles → observations)

`src/simforge_alpamayo/bridge.py` is torch-free (numpy only; PIL only when
resizing) so a policy runner can import it without an inference environment.

- `BundleObservationBridge.for_profile("alpamayo-2cam" | "alpamayo-4cam" |
  "alpamayo-6cam" | "alpamayo-6cam-vqa")` mirrors the authored sensor-rig
  presets in `packages/scenario/src/schema/v2/sensor-rigs.ts`; preset sensor
  ids ARE the dataset camera names, mapped through `ALPAMAYO_CAMERA_INDEX`.
- `push_bundle(bundle)` ingests one tick zero-copy up to the single
  unavoidable RGBA→RGB pack; `observation(ego_history_xyz)` assembles the
  rolling 4-frame window with cameras emitted camera-index ascending.
- `bundle_to_observation(...)` is the one-shot form for single-tick open-loop
  callers. It replicates the single frame across the history window and says
  so in `frame_history: "replicated-single-tick"` — the cold-start
  approximation, labelled rather than hidden.
- `ego_history_rot_from_headings(...)` produces the AlpaSim
  `build_ego_history` rotation convention (FLU, relative to t0).

## Preflight and identity

```bash
python -m simforge_alpamayo.preflight --runtime --json          # can this host run it?
python -m simforge_alpamayo.preflight --family alpamayo-1.5 \
    --expect-digest <64-hex> [--deep]                            # are these the right bytes?
```

Identity and qualification are separate questions on purpose: identity needs
no GPU, qualification needs no weights, and conflating them is how a product
ends up claiming a model runs on hardware it cannot run on. Exit codes:
`0` ok, `2` ran and the answer is "not qualified", `3` identity mismatch.

## Tests and benchmarks

```bash
python3 -m pytest adapters/alpamayo/tests/          # 52 tests, no GPU, no network
```

`tests/test_families.py` pins the three pin sources against each other;
`tests/test_wire.py` pins the refusal contract; `tests/test_bridge.py` runs
the bundle→observation path against a ring recorded by the real Rust render
service.

```bash
# latency p50/p95 + VRAM (server must be running)
scripts/bench_latency.py --iters 12 --out out/bench_nf4.json
# quant divergence on identical inputs; --clip adds golden-clip open-loop minADE
scripts/compare_quant.py --modes nf4 fp8 --n 10 --out out/divergence.json
# render -> bundle -> bridge -> act conformance on a real map tile
scripts/rig_conformance.py
```

Upstream parity scripts for all three families stream
`nvidia/PhysicalAI-Autonomous-Vehicles`, which is `gated: auto` under a
12-month non-redistributable licence. Parity runs therefore need a user token
with dataset acceptance, we cannot ship golden clips, and only parity
*outputs* may be cached.

## Licences and open review gates

Vendored inference code: Apache-2.0 (all three upstream repositories). Model
weights: OpenMDW-1.1 on all three, the identical LICENSE blob
`ec297ac5456384786644013ec196da33b916be97` (confirmed with `git hash-object`
against the upstream bytes).

**Unresolved, and not resolvable by this code:** the Alpamayo 1 and 1.5 model
cards state "ready for non-commercial use; commercial licensing available
upon request" while their LICENSE blob is OpenMDW-1.1; the Alpamayo 2 Super
card omits that sentence. Which text controls has **not** been decided here.
Commercial hosting requires a recorded human/legal review. The application
shows both texts verbatim, `commercialUseReviewRequired` is surfaced per
family, and no code asserts a resolution.
