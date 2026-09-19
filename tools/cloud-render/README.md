# Renting one RTX 3090 to run a CARLA render worker (DEV)

This directory provisions **one** rented RTX 3090 on vast.ai that can run the
existing CARLA render worker against the **dev** control plane, verifies it can
actually run CARLA before any job is leased, and tears it down with a cost
report. It is the A-6 gate in
`artifacts/production-scenarios/cloud-render-and-gallery-plan.md`: *one rented
3090 drains one job end to end*, before any scale-up to eight.

Everything targets dev. `common.sh` refuses a control-plane URL, image ref or
artifact bucket whose name contains `prod` or `staging`.

| File | Role |
|---|---|
| `common.sh` | configuration, measured constants, shared helpers (sourced, not run) |
| `provision-3090.sh` | select and rent one offer; **plan-only unless `--confirm`** |
| `verify-instance.sh` | prove the instance can run CARLA before leasing a job |
| `teardown-3090.sh` | destroy, confirm gone, report accrued cost; safe to re-run |
| `validate-create-args.py` | parse the create argv with vast's own argparse, no API call |

## The exact sequence

```bash
cd artifacts/production-scenarios/cloud

# 0. One-time: vast needs an ssh key or verification cannot log in.
#    The account had NO key registered as of 2026-09-17.
/home/ubuntu/.local/bin/vastai create ssh-key "$(cat ~/.ssh/id_rsa.pub)"

# 1. Plan. Read-only: live offer search, cost model, exact create command.
#    Spends nothing, creates nothing, exits 0.
./provision-3090.sh

# 2. Rent the cheapest qualifying offer. All five values are required: the
#    plan prints MISSING rows for whatever is absent and --confirm refuses.
SIMFORGE_API_BASE_URL=http://<dev-host>:<port> \
SIMFORGE_WORKER_NODE_ID=<studio worker-node id> \
SIMFORGE_RENDER_WORKER_TOKEN=<dev worker token> \
SIMFORGE_SOURCE_REVISION=<40-hex commit the image was built from> \
  ./provision-3090.sh --confirm
#    -> records the instance id in ~/.simforge/vast-3090/instance.json
#       and appends it to ~/.simforge/vast-3090/created-ids.txt

# 3. Prove it can run CARLA. No id to copy: it reads the recorded one.
./verify-instance.sh            # add --skip-engine for the non-GPU checks only

# 4. Lease one job through the render API, then:
./teardown-3090.sh              # --dry-run to see the plan and the cost first
```

`STATE_DIR` (default `~/.simforge/vast-3090`) holds the recorded id; pass
`--state-dir` to all three scripts to use a different ledger.

## What the create command does, and why

```
vastai create instance <offer> \
  --image <ECR dev image> --login '-u AWS -p <ecr token> <registry>' \
  --disk 200 --env '-e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=all …' \
  --ssh --direct --label simforge-render-rtx3090-24gb-v1-dev \
  --onstart <state-dir>/onstart.sh --cancel-unavail --raw
```

- **The instance image *is* the container vast runs.** There is no
  docker-in-docker pull step on the rented host, so the render-worker image has
  to be a registry ref. The 21.5 GB `simforge-carla-runtime:0.1.0-rc.54` on ws2
  is local-only (`RepoDigests: simforge-carla-runtime@sha256:440bb09f…`) and
  cannot be used until it is pushed.
- **`NVIDIA_DRIVER_CAPABILITIES=all`** because the dev image bakes
  `compute,graphics,utility`, and CARLA's Vulkan path needs the full graphics
  library injection. Verification checks this on the instance, not in the plan.
- **`--disk 200`**: the image is ~28.8 GB compressed and the CARLA 0.10.0
  quickstart floor is 130 GB.
- **`--ssh --direct`** so verification can log in and drive the engine.
- **`--cancel-unavail`** so a failed schedule errors instead of silently
  leaving a stopped, still-billing instance.
- **No `--bid_price`**: on-demand, not interruptible. An interruptible instance
  can be outbid in the middle of a 7-minute render.
- **`--label`** is a safety device: teardown refuses any instance whose label
  is not ours.
- **`--onstart`** records the hardware facts and persists the container env for
  later ssh sessions. It deliberately does **not** start the render worker: the
  control transport (`createRenderControlTransport`) is CloudGate's lane, and a
  half-configured worker leasing a real job is worse than no worker.

Query used for offer selection, exactly as required:

```
gpu_name=RTX_3090 num_gpus=1 rentable=true rented=false disk_space>=200 driver_version>=550.0.0
```

ordered by `dph_total` and priced at 200 GiB of storage (`--storage 200`, which
is what makes `dph_total` include the storage component). `driver_version` needs
all three components. The script re-checks the driver and the disk locally after
the search, so a server-side filter that silently stops working cannot hand us a
box CARLA will not run on.

## Dev registration contract

From CloudGate, whose register+lease test pins it. `provision-3090.sh` prints a
`dev registration contract` block on every run, passes each value as create-time
env, and `--confirm` refuses to rent while any row says MISSING — an instance
that cannot register is $0.18/hr of nothing. `verify-instance.sh` re-checks the
ones that are observable on the instance.

| Value | Source | Enforced where |
|---|---|---|
| `SIMFORGE_API_BASE_URL` | dev Studio origin | `--confirm` gate; `control.baseUrl` |
| `SIMFORGE_WORKER_NODE_ID` | Studio worker-node id | `--confirm` gate; sent as `x-simforge-worker-node-id`, register rejects a mismatch |
| `SIMFORGE_RENDER_WORKER_TOKEN` | dev worker token (`tokenEnv`) | `--confirm` gate; never printed, redacted in every listing |
| `SIMFORGE_SOURCE_REVISION` | 40-hex commit the image was built from | validated as 40-hex before renting; the engine refuses to start without it, and it is the engine version the control plane approves |
| `hardwareProfile` | `rtx3090-24gb-v1` | create env, re-checked on the instance |
| `gpuMemoryMiB` >= 23961 | 24576 nominal minus driver reserve | `verify-instance.sh` reads `nvidia-smi` **total**, so a 20480 MiB board cannot register as a 3090 |
| `imageDigest` | resolved live from ECR | validated as `sha256:<64hex>` before renting |
| `baseImage` | `ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia` | create env, compared on the instance |
| `baseImageDigest` | `sha256:f17c639e…` (`carla.Dockerfile:56`) | create env, compared on the instance |
| `baseImagePlatformDigest` | `sha256:baed0d03…` (`carla.Dockerfile:24,57`) | create env, compared on the instance |

**How the engine version is actually resolved.** The config writes no
`engine.options.engineVersion`, so `builtin-engines.ts:179` falls through to
`SIMFORGE_CARLA_SOURCE_REVISION`, then `SIMFORGE_SOURCE_REVISION`, read from the
container environment at engine-load time; a non-40-hex result kills the worker
at startup with a named error rather than registering an unapprovable version.
The create-time env supplies `SIMFORGE_SOURCE_REVISION` and a
branch-built image bakes the same value, so both routes converge. The hazard is
precedence: a stale or malformed `SIMFORGE_CARLA_SOURCE_REVISION` baked into an
image silently outranks what you pass, so `verify-instance.sh` checks that
variable too — unset is a pass, malformed is a failure, and a valid but
different value is reported as the one the control plane will approve.

`studio/migrations/20260917130000_simforge_rtx3090_render_worker_profile.sql`
must be applied on dev first, or the profile insert fails the `hardware_profile`
check constraint. Provisioning cannot verify that from here; the plan output says
so on every run.

### The environment is not the registration surface — `/config/worker.json` is

`renderWorkerIdentity` reads `config.labels`, not the environment, and the
container's `CMD` is `["--config", "/config/worker.json"]`. So the onstart script
projects the create-time env into that file:

```json
{
  "workerId": "<node id>",
  "instanceId": "<vast container id>",
  "engine": { "id": "carla", "options": {} },
  "control": { "kind": "http", "baseUrl": "<dev origin>",
               "tokenEnv": "SIMFORGE_RENDER_WORKER_TOKEN", "requestTimeoutMs": 30000 },
  "labels": { "hardwareProfile": "rtx3090-24gb-v1", "gpuModel": "…", "gpuMemoryMiB": "24576",
              "imageDigest": "sha256:…", "baseImage": "…",
              "baseImageDigest": "sha256:…", "baseImagePlatformDigest": "sha256:…" },
  "scratchDir": "/scratch", "cacheDir": "/cache", "gpuLockPath": "/run/simforge/gpu.lock"
}
```

Three details that are easy to get wrong:

- **`gpuMemoryMiB` is read from `nvidia-smi` on the box**, never from a label or
  the offer. Onstart refuses to write the file at all if the card reports less
  than 23961 MiB or is not a 3090, and `verify-instance.sh` additionally asserts
  the value in the file equals the card's real total.
- **Label values are strings.** `RenderWorkerConfigSchema`
  (`services/render-worker/src/config.ts:35`) types `labels` as
  `Record<string, string>`, so `gpuMemoryMiB` is `"24576"`, not `24576`.
- **The schema is a `strictObject`**, so `instanceId`, `scratchDir`, `cacheDir`
  and `gpuLockPath` are mandatory and no extra keys are tolerated. The directory
  values come from the image's own env (`SIMFORGE_SCRATCH_DIR`,
  `SIMFORGE_CACHE_DIR`, `SIMFORGE_GPU_LOCK`).

### One image is explicitly refused

The 2026-08-23 `rtx3080-pronto-*` dev tags bake the pre-change worker, whose
transport posts to `/v2/workers/register` and `/v2/jobs/claim` — paths the Studio
app has never served — and they bake no `SIMFORGE_SOURCE_REVISION`. The plan
still prints a concrete command against the default tag so the market and the
cost model can be inspected, but `--confirm` refuses to rent against it. Pass
`--image` with a tag built from this branch.

## Cost model

Printed by `provision-3090.sh` from live offer fields; the per-tick figure is
measured, not assumed (`carla-on-3080-handoff.md:159` two-camera 1080p,
`:225` startup share).

| Component | Formula | Example at the 2026-09-17 market |
|---|---|---|
| GPU + storage | `dph_total` at 200 GiB | $0.2037/hr (cheapest qualifying) |
| Image pull | `image_bytes/1e9 × inet_down_cost` | 28.83 GB × $0.0013/GB = **$0.0375**, ~100 s at 2297 Mb/s |
| One 1001-tick two-camera render | `(1001 × 0.431 s + 41 s) × dph/3600` | 472.4 s = 0.1312 h → **$0.0267** |
| First render, all-in | pull + pull time + render | **$0.070** |
| Each later render on the same instance | render only | **$0.027** |

The pull is a real per-instance cost and is charged once; bandwidth price varies
wildly by host ($0.000–$0.039/GB in the qualifying set), so an offer that is
cheaper per hour can be dearer for the first render. The script prices both.

Account credit was $110.85 (credit-only, `balance=0`, `can_pay=true`), i.e.
roughly 540 hours of one such 3090.

## If a step fails

**`provision-3090.sh` — "no offers matched"**
The 3090 market moves minute to minute; two searches four minutes apart returned
disjoint cheapest offers (0.1837 Bulgaria, then 0.2037 British Columbia). Re-run.
If it stays empty, relax in this order: `disk_space>=200` (lower only if you
also lower `--disk`), then the location, never `driver_version>=550.0.0` —
CARLA 0.10.0 will not run below 550.

**`provision-3090.sh` — "the create command is malformed"**
`validate-create-args.py` parsed the argv with vast's own argparse and it was
rejected. The flags were read from vastai 1.5.4
(`cli/commands/instances.py:201-268`); a CLI upgrade may have moved them. The
version warning at the top of every run tells you if you are off 1.5.4.

**`provision-3090.sh --confirm` — "register an ssh key"**
`vastai show ssh-keys` is empty. Verification logs in over ssh, so this is fatal
by design rather than discovered later.

**Instance stuck in `loading`**
It is pulling ~28.8 GB. At the offer's advertised `inet_down` that is 1–6
minutes; hosts that advertise more than they deliver take longer. `vastai logs
<id>` shows the pull. The wait loop gives up after 30 minutes; the instance is
already recorded, so `teardown-3090.sh` will still clean it up.

**`verify-instance.sh` — cannot ssh**
Register/attach a key (`vastai attach ssh <id> "$(cat ~/.ssh/id_rsa.pub)"`) and
re-run; it retries the handshake 12 times at 15 s before failing.

**`verify-instance.sh` — free VRAM below the floor**
The advertised `gpu_ram` is not evidence: one live 3090 offer advertises
20480 MiB. The check reads `nvidia-smi`. Below ~20 GiB free, destroy and rent a
different offer rather than trying to fit the rig — on 10 GiB cards this exact
condition surfaced as `world.tick()` raising a bare `std::exception` during
spawn settle, with nothing about memory in the message
(`carla-on-3080-handoff.md` §3).

**`verify-instance.sh` — total VRAM below 23961 MiB**
Separate from the free-VRAM check: this is the register route's own gate. The
board cannot back the `rtx3090-24gb-v1` profile it would claim, so registration
would be rejected server-side. Destroy and rent a different offer; there is
nothing to tune.

**`verify-instance.sh` — `SIMFORGE_SOURCE_REVISION` is not 40-hex**
The engine refuses to start without it and the control plane approves it as the
engine version. Either the image was built without the `SOURCE_REVISION` build
arg or it was not passed at create time. Do not invent a commit: build or
identify the image whose source revision it actually is.

**`verify-instance.sh` — no NVIDIA Vulkan ICD / no graphics libraries**
`NVIDIA_DRIVER_CAPABILITIES` was not applied. CUDA working is not sufficient;
CARLA needs the graphics libraries. Destroy and re-create — it is a create-time
env, not something to patch in place.

**`verify-instance.sh` — engine never reaches RPC readiness**
Expected occasionally: engine starts fail intermittently, either exiting during
map load or coming up without ever answering RPC. The script retries the whole
launch up to 8 times, each with a 30 × 10 s readiness poll, and never sleeps a
fixed interval — the container reports `Up` long before RPC answers. If all 8
attempts fail, read the engine log tail it prints. Do **not** drop
`-quality-level=Epic`: `Low` removes the assets the spawn-height probe raycasts
against, so it breaks spawning instead of saving VRAM.

**`teardown-3090.sh` — "not in created-ids.txt"**
Working as intended: it only destroys instances this tooling created. If you
rented by hand, destroy by hand.

**`teardown-3090.sh` — "still listed after destroy"**
It polls 15 × 8 s for the instance to disappear and exits non-zero if it does
not. A still-listed instance may still bill; check `vastai show instance <id>`
and destroy again.

**Cost report shows $0 invoiced**
vast posts invoice lines on a delay, so a just-destroyed instance often has no
line yet. The `uptime × rate` figure is computed from `start_date` and
`dph_total` and is frozen into the state file before the record disappears.
Re-run `teardown-3090.sh` later to see the invoiced number.

## Known prerequisites this directory does not own

1. **A dev image built from current source, carrying `SOURCE_REVISION`.** The
   default image (`simcloud-carla-worker-dev:rtx3080-pronto-642b9c5557a7`,
   pushed 2026-08-23, index `sha256:6d5b8578…`) is the newest tagged dev image
   in ECR. It carries
   `UNISCENARIOS_CARLA_IMAGE_MANIFEST_SHA256=baed0d03…a648de64`, the same CARLA
   0.10.0 base pinned at `services/render-worker/docker/carla.Dockerfile:24`, so
   the engine inside it is the build measured at 0.431 s/tick. But its labels are
   `ai.simforge.hardware-profile=rtx3080-10gb-v1` with **no
   `org.simforge.worker.source-revision`**, and it predates CloudGate's
   control-transport work. A freshly built dev image sets
   `SIMFORGE_SOURCE_REVISION` from the `SOURCE_REVISION` build arg
   (`carla.Dockerfile:25,28`); until then the commit has to be passed at create
   time, and passing one that is not what the image was built from would be a
   lie the control plane would then approve. Push a new dev image and pass
   `--image`/`CARLA_IMAGE`.
2. **A dev control plane reachable from the rented instance.**
   `SIMFORGE_API_BASE_URL` has no default on purpose — this checkout has no
   hardcoded dev host (`packages/studio-host/src/node/local-host-supervisor.ts:245`
   falls back to `http://127.0.0.1:<port>`), and a loopback URL is useless to a
   worker in another country. Either expose the dev host or give the instance a
   reverse tunnel.
3. **A fleet gate that admits `rtx3090-24gb-v1`**, plus
   `studio/migrations/20260917130000_simforge_rtx3090_render_worker_profile.sql`
   applied on dev. The gate at
   `studio/app/lib/scenario/render-worker-control-store.ts:115` admitted only
   `rtx3080-`/`rtx5080-` prefixes before CloudGate's change, and without the
   migration the profile insert fails the `hardware_profile` check constraint.
   Provisioning states the hardware truthfully and does not work around either.
4. **A Studio worker-node id and a dev worker token.** Both are issued by the
   dev control plane and are not derivable here.

## Rendering directly on a cook box, without the control plane

The worker image is not required to render. `bringup-cook-box.sh` turns a box
that carries the full production cook into a render host in about 30 s —
it discovers the engine's own carla wheel, extracts it into a venv, copies the
adapter in, installs `xmllint`/`ffmpeg`, writes the Vulkan ICD and starts the
engine — after which `run-local` renders straight from `scenario.xosc`. This is
how the surround-rig crash scenes were produced, and it sidesteps the stale
worker image entirely (that image bundles `engineVersion: native-v1`, rejects
the plane's `uniscenario.*` response tag, and ships the platform `carla_worker`
rather than this adapter, so every claim leases then expires with no log line).

Two things about a bare cook are worth knowing before debugging a silent hang:

- **The Vulkan ICD is missing.** A cook declares no driver capabilities, so
  `/usr/share/vulkan/icd.d` is empty, UE5's render thread never starts and the
  game thread aborts after 60 s with no useful message. The script writes the
  one-line `nvidia_icd.json` itself.
- **The engine refuses to run as root** and its directory must be owned by the
  engine user; the script reads that user off the launcher path rather than
  assuming `carla`.

## Distributing the cook: use ECR, not ghcr

The production cook is ~146 GB unpacked, ~22 GB compressed, and **rented hosts
could not pull it from ghcr**: the large layer retried forever, authenticated
or not. Copying ghcr -> ECR with `crane` from a third box also failed, first
with an HTTP/2 `PROTOCOL_ERROR` and then `unexpected EOF` over HTTP/1.1.

What worked is pushing to ECR **from a box that already holds the image**:

```bash
aws ecr get-login-password | docker login -u AWS --password-stdin "$ECR"
docker tag ghcr.io/simforgeinc/carla-rr-maps:0.10.0-prod-graphics "$ECR/simcloud-carla-worker-dev:cook-prod-graphics"
docker push "$ECR/simcloud-carla-worker-dev:cook-prod-graphics"     # ~17 min
```

Pass the pull credential at create time via vast's `image_login`
(`-u AWS -p <token> <registry>`); the ECR token is valid 12 h, which outlives
any pull. After the switch, 14 of 16 rented boxes pulled the cook without a
single retry loop.

Because pull speed varies by an order of magnitude between hosts and vast's
status reporting is unreliable, the cheapest way to get a working box quickly is
to **race a fleet and keep the winners**: create ~16, poll until the first few
report `running`, destroy the rest. Two failure modes showed up that no amount
of waiting fixes — a host whose DNS cannot resolve the ECR layer bucket
(`...s3.us-east-1.amazonaws.com: no such host`), and a host whose ssh proxy
closes the connection, which the instance's `public_ipaddr` + `direct_port_start`
works around.

## VRAM: what actually fits

Measured with `nvidia-smi` sampled during full renders of production scenarios:

| rig | resolution | peak VRAM |
|---|---|---|
| `parity-front` (1 camera + chase) | 1280x720 | 8.3 - 9.8 GiB |
| `nvidia-sdg-av` (7 surround + chase + lidar) | 1920x1208 | 17.2 - 19.3 GiB |

The map alone is ~6.5 GiB resident **at every quality level** — Low, Medium and
High land within 10 MiB of each other, and `r.Streaming.PoolSize` changes
nothing even though both flags appear in the process command line. Actors cost
~0.7 GiB and eight cameras ~1.5 GiB. So a 10 GiB card cannot host the surround
rig at all: it dies with `Out of memory on Vulkan; MemoryTypeIndex=1` followed by
`Signal 11`. The same pressure, just below the fatal threshold, is what produces
vehicles rendered with doors, lights and wheels but **no body shell** — large
body meshes are the allocations that fail first. Seeing hollow cars in output is
a memory symptom, not a content or blueprint problem.

## Sealing approved scenarios

`seal-scenarios.ts` accepts the approved-document JSON array (`doc`, `dataset`,
`city`, `collision`). **Dry-run is the default:** no network requests, token reads,
or manifest writes. Run with Node 22.18+:

```bash
node tools/cloud-render/seal-scenarios.ts /tmp/wanted-docs.json \
  --base https://dev.simforge.ai \
  --token-file /home/ubuntu/.simforge/devtok/submit-token.txt \
  --manifest /tmp/seal-scenarios.jsonl
```

Required flags are `--base` (HTTP(S) origin) and `--token-file` (bearer token,
never printed). Optional flags: `--evidence-file`, `--manifest` (default
`/tmp/seal-scenarios.jsonl`), `--concurrency` (default 3, maximum 32),
`--poll-ms` (2000), `--timeout-ms` (600000 per export), and `--confirm`.
Only `--confirm` enables revision POSTs and export polling; it does not submit
render jobs. The caller must have write access to each document's workspace.

The revision API requires already-uploaded, completed materialized traffic,
**even for disabled ambient traffic**. `--evidence-file` is a JSON object keyed by
document ID, with each value containing `workspaceId`, `expectedVersion` (saved
draft version), `ambient` (the API's complete ambient provenance), and
`materializedTraffic` (`artifactId`, `sha256`, `sizeBytes`, `sourceInputDigest`,
`mapAssetId`, `mapVersionId`). Its digest must equal `ambient.resultSha256`.
Obtain this from the map-bound traffic preparation followed by the document's
`materialized-traffic/reserve`, checksum-bound storage upload, and
`materialized-traffic/complete` protocol. The tool does not invent traffic or
silently disable authored ambient traffic. Missing evidence prints a **BLOCKED
body template**, not an executable request; supplied evidence prints the exact
POST body, origin and workspace.

Confirmed runs append durable JSONL records (`base`, `document`, `revision`,
`export`, `executionPackage`, `status`, request body and workspace). Reuse the
same manifest to skip sealed documents or resume a pending export. The exact
request is saved before POST and uses a deterministic per-origin/document
idempotency key. Failures are recorded per item; other documents continue.
Use one process per manifest. Sealed entries represent this campaign snapshot,
not a request to reseal later draft edits. Dry-run leaves the manifest unchanged.
