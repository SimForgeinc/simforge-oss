# Situation-first authoring: operating guide

This is the current operating surface for the situation-first experiment, not a
replacement for the portable-template product CLI. Current scenario authors use
`anthropic/claude-opus-5`, **high** request effort, through **Starline OMP**.
Scoped participant critics and both independent judge ensembles remain
`openai-codex/gpt-6-astra`, **low** effort. This is an author-only model change.
Only authoring arms **C** (situation tools, no branching) and **D** (the same tools
with branching) are active. There is no legacy author/control adapter, exemplar
retrieval, human acceptance step, or runtime fallback to historical output.
A scenario's paired causal control is still required; it is not a removed
*authoring* control arm.

Michael also requested a later matched author comparison: `openai-codex/gpt-5.6-sol`,
`openai-codex/gpt-6-astra`, `anthropic/claude-opus-5`, and
`anthropic/claude-fable-5-1`. Keep judge policies fixed while varying the author
at the same declared high-effort setting. Retain C/D branching arms, frozen briefs,
budgets, rendering, failures and cost uncertainty. Provider effort labels do not
establish identical internal compute. This comparison is planned, not a reported result.
For that comparison, Michael selected **freeze sensing per brief**: choose and
freeze the appropriate participant-sensing policy before authoring, then give all
models/arms that same policy for the brief. Keep assigned-policy identity separate
from actual compiler-lowered channels and reported observations. A declaration
alone never establishes execution or sensor fidelity. This freeze remains a
prerequisite for the later comparison, not a qualification of the current pilot.
The author request deadline is 600 seconds at high effort, common to all four
models. Low-effort critics/judges retain 180 seconds. Both have zero transport
retries. The former 180-second high-effort deadline caused an observed author
abort; older receipts remain unchanged and cannot qualify under the new deadline.

## Prerequisites and build

Commands below use the existing workstation paths. They are operating recipes,
not claims that the commands or benchmark were completed. Preserve every input
and historical output. A new invocation uses a fresh output directory; do not
reuse an old result directory to improve its reported result.
Evidence references beginning `implementation/` are relative to
`/home/path/tmp/scenario-generation-rethink-2026-09-04/`, not the repository.

Required: Linux for the owned supervisor, Node, the repository's pinned pnpm,
the Rust toolchain for the native runtime addon, working Blender/Cycles GPU
support, the published map corpora and map bundles, atlas sites, source-backed
actor assets, and the source HDRI. The experiment's map IDs are `yale-street`,
`belmont-research-center`, `el-camino-road`, and `easterbrook-discovery-school`;
these are the existing local experiment bundles, not permission to rename
current map-registry IDs.

```sh
cd "$SIMFORGE_ROOT"   # this repository checkout
pnpm install --frozen-lockfile
npm ci --prefix experiments/agentic-3d/pi-harness
pnpm --filter @simforge-oss/native-runtime build:node   # the N-API addon; wasm is not needed here
pnpm --filter @simforge-oss/native-runtime build:ts
pnpm --filter @simforge-oss/compiler... --filter @simforge-oss/asset-catalog... build
export SIMFORGE_GATEWAY=http://127.0.0.1:4141/v1
export WORK=$(mktemp -d /home/path/tmp/situation-ops-XXXXXXXX)
export FROZEN_BRIEFS=/home/path/tmp/scenario-generation-rethink-2026-09-04/implementation/benchmark-opus5-high-v1
```

Every compile, rehearsal, solve, comparison, replay and scene-state emission
executes in the native runtime (`@simforge-oss/native-runtime`); the public
`@simforge-oss/compiler`, `engine`, `scenario`, `maps` and `asset-catalog`
packages are façades and DTO/file boundaries over it. Experiment modules are a
private workspace package (`experiments/agentic-3d/package.json`) and import
those packages by name; there are no `dist` path imports, no runtime discovery
and no fallback to any TypeScript simulator. A missing or mismatched addon is
an installation error and every command reports it as one.

`experiments/agentic-3d/runtime-identity.mjs` captures the runtime that actually
executes: the loaded addon's path and byte hash, engine/ABI version, every
published artifact of the public packages (from each `package.json` `files`
list), the lockfile, the Blender renderer sources and the local authoring
modules. Each authoring run writes `runtime-identity.json` beside `source.json`
and refuses to resume on a different runtime; `run-frozen-brief.mjs` re-checks
those hashes after the run and records a changed runtime as an infrastructure
failure. Never build or edit pinned runtime files during a benchmark. A build
is not renderer or policy qualification. The separate `pi-harness` lockfile
supplies the actual gateway Agent transport.

### Gateway identity, not merely an open port

Use the already-owned Starline OMP gateway on 4141. Do not restart a user's
gateway, substitute standalone OMP, change its bind/auth configuration, or silently
substitute a model. For an authenticated gateway, supply its existing
`SIMFORGE_GATEWAY_TOKEN_FILE` (never broker credentials). The normal local
no-auth gateway needs no token override.

```sh
node experiments/agentic-3d/gateway-probe.mjs --model anthropic/claude-opus-5 --effort high --output-dir "$WORK/author-gateway-probe"
node experiments/agentic-3d/gateway-probe.mjs --model openai-codex/gpt-6-astra --effort low --output-dir "$WORK/judge-gateway-probe"
```

The probe exercises image input, structured tool arguments/results, requested
effort and returned model routing; it records the actual exchange. Retain
those receipts. Also retain the owning service's executable/version provenance:
a successful HTTP request alone does not prove that its process is Starline OMP.
Model catalog/routing and request-effort checks remain enabled for actual agents.
The transport's zero-valued price fields are **not measured free inference**;
unknown cost remains unknown.

The retained synthetic Opus probe at `implementation/opus5-gateway-proof-v1`
was refused by the provider as `reasoning_extraction`; it is not a passing probe.
The actual scene-authoring session at `implementation/opus5-development-01-v1`
subsequently executed real tool requests with verified `claude-opus-5` routing.
`implementation/author-model-switch-proof.json` retains that narrower proof.
The Astra judge image/tool probe passed. Do not replace refused probes with
invented results or substitute another author model.

## Freeze model inputs and per-brief sensing

Prepare all four author inputs from one retained source. Brief arrays, allocation,
seeds, budgets and judge policies remain identical; author routing fields differ.
Preparation is explicitly `planned-not-run`, not benchmark execution.

```sh
node experiments/agentic-3d/prepare-situation-benchmark.mjs \
  --source "$FROZEN_BRIEFS" --out "$WORK/model-comparison" --all-author-models
export BENCH="$WORK/model-comparison/anthropic--claude-opus-5"
export SENSING="$WORK/frozen-sensing"
node experiments/agentic-3d/freeze-situation-sensing.mjs \
  --cohort "$BENCH/development.json" --cohort "$BENCH/fresh-1.json" \
  --cohort "$BENCH/fresh-2.json" --cohort "$BENCH/fresh-3.json" \
  --out "$SENSING" --concurrency 4
node experiments/agentic-3d/freeze-situation-sensing.mjs --verify "$SENSING"
```

The independent Opus-high instrumentation planner receives each entire frozen
brief and only the canonical sensor catalog. Each brief gets at most four
requests; the first valid submission is immutable. All 204 assignments are
recorded before planning. Failed policies remain assigned failures, with no
fallback or reroll; valid policies remain usable without dropping failed briefs
from the denominator. Never regenerate policies separately for another model.

Policies pin the exact brief, canonical constructors/rigs, source/build/runtime
and explicit sensor IDs. The pinned runtime is the native addon (path, byte
hash, engine/ABI version), the published package artifacts and the sensing
module itself; a policy frozen under another addon or package build fails
`runtime_mismatch` and is not silently re-lowered. Policies in
`implementation/frozen-sensing-v1` were frozen under the former TypeScript
runtime identity and therefore cannot validate against the native runtime; they
remain retained evidence of that attempt, not usable assignments for it.
Authors bind exact participant labels to concrete role
IDs in `template.extensions.sensingPolicy`, then explicitly apply the canonical
sensor arrays returned by the `sensing` tool. No hidden sensor insertion occurs.
Real compiled inputs and full native traces are checked separately from declared
recipes. Physical absence does not imply a changed sensing recipe; a report at
time zero can precede a same-tick despawn. Synthetic reports are not calibrated
pixels or human perception. Review and corpus replay verify these distinctions.

The completed assignment attempt at `implementation/frozen-sensing-v1` contains
203 verified policies for 204 original briefs: 11/12 development and 64/64 in
each fresh cohort. `development-01` ended with a terminated stream before a valid
submission; it is not replaced. The collection reports `complete: false`, while
its 203 verified policies remain usable. `implementation/frozen-sensing-summary.json`
records 421 planning requests and the incomplete coverage; total price is unknown.

The separate compound workflow at `implementation/frozen-sensing-compound-workflow-v1`
ended author-reported `unsupported` after 57 requests and 11 cycles, not accepted.
`implementation/compound-sensing-execution-proof.json` validates all 16 saved
executions against its frozen policy. One actual submission failed the causal
preflight and consumed zero independent judge requests. Failed arrangements are
not proof that the engine cannot express every conditional alternative.

## Prepare a real map, without inheriting a scenario

The preparation tool consumes the published `.corpus`, atlas and renderer
lighting products. It verifies published file hashes, selects a directly grounded
atlas site, includes all published static and vegetation geometry at the chosen
LOD, and keeps the road at full resolution. The lighting manifest contributes
only lighting/HDRI: no actors, routes or camera scenario are inherited.

```sh
node experiments/agentic-3d/blender-map-workbench.mjs \
  --map yale-street --out "$WORK/maps/yale-street" \
  --lighting-manifest /home/path/tmp/renderer-bakeoff-2026-09-04/workload.json \
  --lighting-case daylight --lod 2
node experiments/agentic-3d/blender-map-workbench.mjs \
  --map belmont-research-center --out "$WORK/maps/belmont-research-center" \
  --lighting-manifest /home/path/tmp/renderer-bakeoff-2026-09-04/workload.json \
  --lighting-case daylight --lod 2
```

Outputs are `manifest.json` (an empty `map-only` case) and `preparation.json`
(source pins, producer identities, LOD and diagnostic camera provenance).
Optional supported flags are `--corpus-root`, `--atlas-root`, `--site`, and an
explicit `--lod` from 0 to 3. A missing source, bad hash, missing requested LOD or
unavailable HDRI is a failure, not a reason to fabricate a primitive map.

If decoded products are unavailable, the existing producer can create a **new**
root; never rebuild `.corpus` in place:

```sh
node packages/cli/bin/simforge.js corpus build \
  --maps yale-street,belmont-research-center --out-root "$WORK/decoded-corpus"
```

Then use `--corpus-root "$WORK/decoded-corpus"` with preparation into a new
output directory. This requires the original map assets; it cannot recover
missing original data. Prefer the already-published products when valid.

## Owned Blender services

**Do not touch port 8766.** Port 8767 is the private interactive workbench; reuse
it only when its owner and map identity match the intended work. Do not launch a
second server on it or stop another session's server. Schedule GPU occupancy
before starting a workbench. Use the harness process manager (`hub start`) for
long-lived launches; preserve its owned handle and stop only that handle.

The actual executable/arguments for a new private Yale instance are:

```sh
/snap/blender/7740/blender --background --factory-startup --disable-autoexec \
  -noaudio --threads 8 --python-exit-code 1 \
  --python renderer/blender/workbench_server.py -- \
  --manifest "$WORK/maps/yale-street/manifest.json" --case map-only \
  --state-dir "$WORK/private-blender-state" --port 8767
```

Pass that executable and argument vector to the owned process manager, with
repository working directory and `PYTHONUNBUFFERED=1`. This is an alternative to
the benchmark supervisor, not a requirement to run both simultaneously. The
startup banner is `Workbench HTTP ready at http://127.0.0.1:8767`. It establishes
HTTP availability only. Inspect the real state before authoring:

```sh
curl --fail --silent --show-error http://127.0.0.1:8767/api/state
```

Require `ready: true`, `busy: false`, the correct `mapId`, no `lastError`, and
`initialCameraGround` from the exact source-road raycast. Check the actual frame
at `http://127.0.0.1:8767/`. A diagnostic camera is not an ego policy sensor.
The authored-map runner also rejects outstanding visual-only patches: geometry
appearance edits must not silently become physics, road-rule or collision truth.

## One bounded authoring run

With an owned, ready Yale workbench on 8767:

```sh
node experiments/agentic-3d/situation-loop.mjs \
  --brief 'About 20 seconds: ego passes a parked delivery van outside the travel lane. Compare with moving only the van partly into the lane; measure clearance and speed while preserving all undeclared inputs.' \
  --map yale-street --out "$WORK/single-run" --seed situation-ops-20260905 \
  --workbench http://127.0.0.1:8767 --branching true \
  --max-calls 32 --max-rehearsals 24 --max-submissions 6
```

Use exactly one of `--brief`, `--brief-file`, or `--brief-record JSON`.
Standalone `--sensing-policy FILE` requires the independently frozen
`--brief-record`; benchmark assignments supply both automatically.
`--capability-memory FILE` is optional, but benchmark briefs, successful scenarios
and exemplars must not enter that memory. `--resume-infrastructure true` is the explicit infrastructure
resume option; it is not permission to reset exhausted budgets or relabel a
new attempt as the first run. CLI exit 0 means `ensemble_accepted`, 2 means a
completed nonaccepting outcome, and 1 denotes a command/infrastructure exception.
Inspect the persisted outcome rather than treating process completion as success.

A frozen assignment is preferable for comparisons:

```sh
node experiments/agentic-3d/run-frozen-brief.mjs \
  --cohort "$BENCH/development.json" --id development-01 \
  --arm D --mode matched --out "$WORK/development-01-D" \
  --workbench http://127.0.0.1:8767 --sensing-freeze "$SENSING"
```

This records exact `cohort.json` and `protocol.json` snapshots, `assignment.json`,
`runtime-identity.json`, the assigned `sensing-policy.json` and authoritative
`outcome.json` beside run artifacts. It checks the protocol/cohort, author
model/effort/deadline and current scenario/diversity policies. Missing or invalid
sensing remains an infrastructure outcome for the assigned brief. Do not
substitute old `result.json` files or synthetic smoke outcomes for assigned evidence.

## C/D v2 benchmark and resource caps

Use a newly prepared model directory above. Its model/effort/deadline amendment preserves 12 development
briefs and three fresh cohorts of 64, including 8 held-out briefs in each fresh
cohort. The frozen protocol **requires** C/D to match model, source opportunities,
seed, asset library, renderer, participant sensor recipe and acceptance policies,
with branching as the arm difference. These are pairing requirements, not a claim
that identical renderer or participant-sensor behavior has been demonstrated.
The reporters require render, sensor and reviewer metadata in
`outcome.attestations`; the current runner does not emit those attestations.
Actual comparable-pair and qualification gates therefore remain withheld where
this evidence is missing. Missing metadata is not equality. Renderer changes
must be separate declared ablations.

The director defaults to Opus 5 high. `situation-loop.mjs --author-model MODEL_ID`
selects one of the four supported author models; `--author-effort high|low` makes
an explicit author-effort choice. Both values are persisted and cannot change
when resuming a session. Frozen assignments take them from their verified
protocol and cohort. Never relabel an earlier low-effort/Astra run or combine
different model/effort protocols as one matched C/D result.

| Mode | Model requests | Attempted rehearsals | Submissions | Max output tokens/request |
| --- | ---: | ---: | ---: | ---: |
| `matched` | 32 | 24 | 6 | 16000 |
| `naturalStopping` | 64 | 48 | 12 | 16000 |

An iteration is an attempted rehearsal cycle, including compile/tool failure;
inspection alone does not increment it. Keep model requests, tool invocations,
semantic edits, failures, submissions and elapsed/queued time separate. Three
scenario reviewers consume three real model requests; reserve them within the
bounded run rather than granting an invisible extra budget.

Keep shared sensing-planning requests, wall time and unknown prices visible
separately from per-author budgets. Do not silently count that preparation as
free inference or infer an amortized cost without declaring the allocation.

Saved frame evidence retains the renderer's observed configured `device`,
`persistentData`, `renderMs` and `writeMs`, plus client
`imageTransfer.frameHttpReadMs` and `displayPngEncodeMs`. The latter measure frame
HTTP fetch/hash and display-PNG resize/encode, not GPU readback. A cache hit
performs neither image operation and reports those durations as zero.
`implementation/image-transfer-timing-proof.json` verifies real uncached/cached
transfer with identical pixels. These observations do not establish binary
identity, complete applied render settings, calibrated photometry or policy pixels.

The following creates an actual supported supervisor configuration for the
first development brief in both arms and both modes. It is deliberately a
**four-assignment subset**, not a complete benchmark. Run it instead of a manual
private workbench when GPU residency permits:

```sh
node --input-type=module -e '
import fs from "node:fs";
const w = process.env.WORK;
fs.writeFileSync(`${w}/supervisor-input.json`, JSON.stringify({
  cohortFile: `${process.env.BENCH}/development.json`,
  sensingFreeze: process.env.SENSING,
  out: `${w}/benchmark-development`,
  ids: ["development-01"], arms: ["C", "D"],
  modes: ["matched", "naturalStopping"],
  manifests: {"yale-street": `${w}/maps/yale-street/manifest.json`},
  blenderExecutable: "/snap/blender/7740/blender",
  basePort: 8878, residentCapacity: 1, concurrentCapacity: 1,
  startupTimeoutMs: 600000, assignmentTimeoutMs: 3600000,
  sampleIntervalMs: 5000
}, null, 2), {flag: "wx"});'
node experiments/agentic-3d/situation-benchmark.mjs --config "$WORK/supervisor-input.json"
```

Launch the supervisor through the owned process manager for unattended work.
It owns its Blender/author subprocess groups and private ports starting at 8878,
checks readiness and map identity, journals `execution.json`, and writes
`manifest.json` and a normalized `config.json`. **Resume with the original input
configuration**, not the normalized output: input `manifests` values are file
path strings, while output values contain pins. Concurrent capacity cannot exceed
resident capacity. Increasing either is a measured GPU/memory scheduling decision,
not evidence that the system supports a particular scale. The port range may not
include 8766 or 8767. Only owned groups are signalled on shutdown.

The actual two-resident attempt exhausted GPU memory: the first matched C outcome
was budget/insufficient and matched D was infrastructure failure. The batch was
stopped with all attempts preserved. The capacity-one resume launched **zero
authors**: all 12 assignments were already completed, failed or interrupted,
with zero productive completions. This proves no-rerun behavior, not resumed
one-worker authoring or qualified throughput. Any serial development repeat must
be explicitly labeled and stored separately, never substituted into the original
batch's acceptance denominator. Start conservatively with the one-resident
configuration above, without treating that configuration as measured success.
The separate high-effort pilot at `implementation/opus5-high-workflows-v1`
subsequently ran with peak active/resident capacity one and reused the same
Blender PID for two assignments. It produced no accepted scenario: one budget
exhaustion, one author-request timeout, and one Belmont import failure. The
Belmont numeric-suffix defect is now reproduced and fixed; full startup and
rendering passed at `implementation/belmont-startup-v2` with 7,433 objects and
7,400 meshes. These mechanism proofs do not establish accepted throughput.

A further reuse defect was reproduced: changing samples from the observed
32-sample startup baseline to 48 caused the next author to inherit 48.
`begin-authoring` now restores the captured baseline engine/samples along with
the scene. `implementation/renderer-reset-reproduction.json` and
`implementation/renderer-reset-fixed-proof.json` retain the failing/passing
actual service runs. Per-author sampler choices must not leak into the next run.

To reduce concurrency on resume without changing the frozen input configuration:

```sh
node experiments/agentic-3d/situation-benchmark.mjs \
  --config "$WORK/supervisor-input.json" --capacity 1
```

`--capacity N` is a positive, reduction-only override bounded by configured
concurrency. Each supervisor session records configured and effective concurrent
and resident caps. Resume schedules only untouched queued assignments; completed
or interrupted attempts are never automatically rerun or replaced. Do not delete
attempt directories or alter the input configuration to bypass this rule.

For a full cohort, select every frozen ID from its cohort JSON and prepare all
maps that those IDs require; use a separate output per cohort. Keep both arms
and modes, then collect all four cohort manifests. Do not regenerate briefs,
exclude failures, replace held-out cases, or use the old factory. Exact input
identity is required for supervisor resume. Direct-child RSS/CPU observations do
not measure descendant usage or GPU memory; absent measurements stay null.

```sh
node experiments/agentic-3d/situation-benchmark-report.mjs \
  --manifest "$WORK/benchmark-development/manifest.json" --out "$WORK/report.json"
node experiments/agentic-3d/situation-benchmark-collection.mjs \
  --manifest "$WORK/benchmark-development/manifest.json" --out "$WORK/collection.json"
```

Repeat `--manifest` to supply all cohort manifests to the collection reporter.
The subset above must remain incomplete. Every assigned failure remains in the
denominator. Three fresh passes must each meet >=90% eventual acceptance,
>=90% held-out acceptance and <=8 median accepted iterations; also report capped
all-assignment iterations. First-submission acceptance is a separate metric.
Numeric success alone does not establish fulfilled diversity or efficacy.

## What independent automated acceptance means

Each scenario review has three fresh no-tool Astra-low contexts, one request per
member, no author transcript and no access to other verdicts. Perspectives differ
(intent/temporal, causal/execution, grounding/evidence), but **every member judges
every fixed rubric criterion** against the same immutable evidence digest.
All three members must be valid; at least two must accept. Dissent, insufficient
judgments, invalid responses and errors are retained. No rerolls on unchanged
evidence, alternate models or manually manufactured verdicts are allowed.
Independence here means independently initialized contexts, **not** independent
model families, statistical independence or objective ground truth.

The sequence is **replay, freeze evidence, mechanical preflight, judge, then accept**. The `review`
tool performs and caches the two actual deterministic base/control replays
**before** invoking judges. `frozen.replayProof` carries their exact input and
trace hashes, so judges receive executed replay evidence rather than a promise
that acceptance will produce it later. Optional `review.evidenceIds` attaches
at most 12 unique successful `query`, `inspect` or `measure` results, using their
exact saved grounding output rather than author paraphrases.
Event/causal gates, both required camera kinds, asset/pixel integrity, visual
closure and frozen sensing execution are checked before spending judge requests.
Failed actual submissions remain recorded. Acceptance repeats the same mechanical
checks and additionally requires exact independent dispositions for capability findings.

Frozen base/control `participantEvidence` includes the actual resolved
`sensorRecipe`, executed channel count and full time-resolved positive detection
reports over the clip. The same reported-only extractor serves scoped participant
critics; missed-target identities are excluded. This is executed reported-channel
evidence, not attested pixel input, sensor fidelity, or proof of identical recipes
between authoring arms. Ordinary authoring summaries remain compact.

The replay-before-judgment reproduction passed mechanical checks but received
one accept and two insufficient votes, so it did **not** establish acceptance.
Adding the previously omitted participant evidence changes the review evidence;
its in-progress three-judge evaluation is not a successful result. The original
C `naturalStopping` outcome remains infrastructure failure, not replaced by
these diagnostic reproductions.

The deterministic `accept` gate rechecks the replay proof that was judged;
it does not execute a second pair of replays. It also checks source/asset and
saved-pixel hashes, the named predicted causal effect, declared invariants,
actual event evidence and the current ensemble policy. This sequence describes
the implementation contract, not a claim that a reproduced run was accepted.
Accepted state
is `status: "ensemble_accepted"`; its decision binds `comparisonId`, `reviewId`,
`replayId`, `controlReplayId`, `evidenceDigest`, `policyDigest`, and
`qualification: "automated"`. Consumers validate that retained evidence; they
must never create acceptance from a status label or a successful replay alone.

Corpus diversity uses a **separate** three-member ensemble under
`DIVERSITY_REVIEW_POLICY`, inspecting the collection reporter's exact `evidence`
and `evidenceDigest`, including per-case outputs and failures. Marginal counts,
brief labels, maps/colors or timing changes do not establish fulfilled diversity.
The dedicated runner uses fresh verified gateway reviewers:

```sh
node experiments/agentic-3d/situation-diversity-review.mjs \
  --manifest "$WORK/benchmark-development/manifest.json" --out "$WORK/diversity-review"
node experiments/agentic-3d/situation-benchmark-collection.mjs \
  --manifest "$WORK/benchmark-development/manifest.json" \
  --diversity-review "$WORK/diversity-review/review.json" \
  --out "$WORK/collection-reviewed.json"
```

Repeat `--manifest` in both commands for the same full set of cohort manifests.
The runner freezes `evidence.json`, records `input.json`, and writes `review.json`,
`metrics.json` and retained gateway sessions. It supplies complete textual
collection evidence and retained per-scenario evidence records, not image bytes;
pixel inspection remains with the per-scenario reviewers. Corpus model requests,
elapsed time and costs are separate evaluation overhead, not extra hidden
authoring budget. Unknown prices remain unknown.

An existing output covering the same evidence and current policy returns the
retained review, including invalid/error verdicts, without a reroll. An existing
incomplete or differently bound output is rejected; do not choose a new output
directory merely to buy another verdict on unchanged evidence. Exit 2 means an
invalid or nonaccepting ensemble; exit 1 denotes a command failure.

The collection reporter only **consumes and validates** this review; it cannot
manufacture acceptance. Without an accepting, validated review of the exact
collection digest, diversity remains incomplete and qualification is withheld.
Reviewing the four-assignment example does not complete the frozen benchmark.
Even `automated-qualified` is not ground truth, native renderer fidelity or
measured-twin qualification.

## Replayable corpus

The dedicated consumer is `experiments/agentic-3d/situation-corpus.mjs` (not the
map decoder's `simforge corpus build`). Export validates runs and keeps accepted
entries separate from failures. It snapshots run evidence while immutable
maps/assets/geometry remain explicit, hash-pinned external dependencies. Retain
those dependencies at their declared paths; this is not a self-contained asset
redistribution archive.

After the single run above, these commands preserve the export receipt separately
from the corpus and use its manifest digest as the verification trust anchor:

```sh
node experiments/agentic-3d/situation-corpus.mjs export \
  --out "$WORK/replay-corpus" --run "$WORK/single-run" > "$WORK/corpus-export-receipt.json"
export CORPUS_SHA256=$(node --input-type=module -e '
import fs from "node:fs";
console.log(JSON.parse(fs.readFileSync(`${process.env.WORK}/corpus-export-receipt.json`, "utf8")).manifestSha256);')
node experiments/agentic-3d/situation-corpus.mjs verify \
  --corpus "$WORK/replay-corpus" --sha256 "$CORPUS_SHA256"
node experiments/agentic-3d/situation-corpus.mjs replay \
  --corpus "$WORK/replay-corpus" --sha256 "$CORPUS_SHA256"
```

Repeat `--run` to export multiple assigned runs. An unsuccessful run remains a
failure, not a replayable accepted entry; do not claim success from an empty
accepted set. `replay --entry entry-0001` restricts execution to that accepted
entry when present; omitting `--entry` selects all accepted entries. Replay
executes the canonical comparison and checks exact base/control inputs, traces
and comparison output. Preserve the original manifest digest outside the mutable
corpus; computing a new digest from a modified manifest defeats tamper checking.
Replay verifies retained judgments and saved pixel bytes, not newly rendered
policy observations or a new ensemble acceptance. Each replay result names both
runtimes: the `runtime-identity.json` retained with the accepted run and the
identity of the replaying process, with `sameRuntime` stating whether they are
byte-identical. An exact trace match across two different native builds is a
reproducibility observation about those two builds, not a qualification.

## NuRec and offline-twin sources

`experiments/agentic-3d/situation-nurec.mjs` binds an imported NuRec bundle as
an immutable situation source and executes against it through the same native
runtime, without launching any renderer or model:

```sh
export I=/home/path/tmp/scenario-generation-rethink-2026-09-04/implementation
export BUNDLE="$I/nurec-fixture/<imported-bundle>"   # an existing import, never rebuilt here
node experiments/agentic-3d/situation-nurec.mjs inspect "$BUNDLE" replay \
  --source-package "36665d69be03ff99b6e2f44916a6b3712e1b8d74b6dfeb837e10e575a3d592f7=$I/native-source/007a5809-8a56-40b5-8af5-7e0f65229496.usdz" \
  > "$WORK/nurec-binding.json"
node experiments/agentic-3d/situation-nurec.mjs fork "$BUNDLE" "$WORK/nurec-fork" "$WORK/patch.json"
node experiments/agentic-3d/situation-nurec.mjs inspect "$WORK/nurec-fork" > "$WORK/nurec-fork-binding.json"
# nurec-program.json: a SituationProgram whose `source` is copied verbatim from the fork binding's `source`.
node experiments/agentic-3d/situation-nurec.mjs rehearse "$WORK/nurec-fork" "$WORK/nurec-program.json" nurec-ops-20260905 \
  --out "$WORK/nurec-rehearsal"
node experiments/agentic-3d/situation-nurec.mjs bind "$WORK/nurec-fork" "$WORK/nurec-rehearsal/scene-state.json"
```

`inspect` verifies every imported artifact hash, the source package identity
and the fork closure, and returns the frozen binding (`source`, participants
with recorded/controller/policy authority, time envelope, unsupported
operations). `fork` composes rigid actor edits and region replacements into a
NEW directory whose `background.json` carries a `sourcePatch`; capture,
calibration and the original background identity are copied unchanged and
re-verified on every load. `rehearse` takes a `SituationProgram` whose
`source` is exactly the binding's source, builds the executable map bundle from
the clip-local `map/` artifacts through the compiler's native bundle façade
(signal catalog, speed limits and derived index are derived natively; location
intel by the maps producer), runs the native rehearsal, emits the canonical
scene-state natively, and writes `program.json`, `rehearsal.json`,
`scene-state.json`, `runtime-identity.json` and `summary.json` (program
digest, input hash, trace hash, event/constraint witnesses, envelope, and
`sceneStateBinding`: whether the fork accepted the emitted state, with the
exact rejection reason otherwise).
`bind` validates a canonical scene-state document against the immutable fork:
only pinned rigid-track or fork-mesh actors, ego present, ticks inside the
half-open envelope. None of these steps renders, closes a loop with the
reconstruction, or qualifies fidelity; `--source-package` verifies package
bytes but does not establish GPU support. A program that names a missing
source, an actor without a pinned track or mesh, or a policy authority is
rejected by the command, never repaired.

No measured-twin or calibration data is generated by any of these commands.
The offline-twin material listed under evidence boundaries below remains a
lossy API projection; there is no local transaction-consistent export to bind,
so no twin-backed recipe is provided here.

## Optional native renderer startup

The native renderer uses a separate pinned environment and immutable source
package. Allocate GPU residency separately; do not launch it beside a Blender
authoring worker when that exceeds available memory. Never stop unrelated GPU
workloads. The following is the retained native service launch specification;
pass the executable and arguments to the owned process manager:

```sh
export I=/home/path/tmp/scenario-generation-rethink-2026-09-04/implementation
"$I/native-runtime/env.sh" python -m simforge_splat.service \
  --socket /tmp/situation-nurec-native.sock \
  --shm /tmp/situation-nurec-native-ring --shm-size-mb 256 \
  --scenes-root "$I/nurec-fixture" --max-scenes 1 \
  --source-package "36665d69be03ff99b6e2f44916a6b3712e1b8d74b6dfeb837e10e575a3d592f7=$I/native-source/007a5809-8a56-40b5-8af5-7e0f65229496.usdz" \
  --hood-dir "$I/native-source/hoods" \
  --catalog catalog/vehicles-carla \
  --catalog catalog/pedestrians-carla
```

Use repository working directory. Readiness includes the
`splat-render-service ... listening on ... (protocol 2, ...)` banner and a real
`NativeRenderClient` hello, not socket-file existence alone:

```sh
"$I/native-runtime/env.sh" python -c 'from simforge_native.client import NativeRenderClient; c=NativeRenderClient("/tmp/situation-nurec-native.sock"); print(c.hello); c.close()'
```

`implementation/native-runtime/environment-manifest.json` records source,
dependency, toolkit and native-render proof identities. The existing source
package, hood files, environment and matching CUDA/GPU support are prerequisites.
Do not replace missing packages with mesh proxies or call this startup check a
closed-loop fidelity pass. The original O2 qualification remains separately open.

## Evidence boundaries and historical preservation

- **Actor-relative cameras are diagnostic, not attested policy pixels.** A visible
  target in a reviewer image is not proof that a participant detected it. Scoped
  participant critics see only their recorded reported detections, not missed
  targets, hidden actors, world truth or future state. Built-in controller behavior
  is not an external policy callback, and authored intentions are not measured minds.
- **Sensor diagnostics are not automatically control inputs.** Built-in
  longitudinal governors are not autonomous passing planners. Ego's optional
  geometric range/FOV/line-of-sight gate is distinct from per-sensor reports;
  non-ego governors use world state. Conditional authored actions are separate
  primitives. Do not infer perception-driven participant behavior from a valid
  sensor-channel audit or an offline participant critic.
- **Native fidelity remains unqualified.** The preserved original-20 inventory
  records **15/20 (75%)** majority agreement, below 16/20 (80%), with five both-fail
  cases. See
  `/home/path/tmp/scenario-generation-rethink-2026-09-04/implementation/nurec-fidelity-preparation/historical-v1/inventory.json`.
  Its corrected cohort is recorded as not run. Do not combine fifteen historical
  agreements with five new cases, substitute the training-24 cohort, or treat
  native render repeatability as task-fidelity success.
- **Qualified measured-twin evidence is missing.** A bounded public history
  response with 129 actual production observations is preserved under
  `implementation/measured-twin-api-v1`; it is a lossy API projection, not the
  transaction-consistent SQLite export or capture-calibrated truth. Its missing
  rowids, frame records and calibration lineage are not manufactured. Exact
  production SQLite read access is blocked by Tailscale authorization.
- Preserve
  `/home/path/tmp/scenario-generation-rethink-2026-09-04/implementation/frozen-v39.5`,
  the original benchmark-v1, historical native receipts, all old runs/archives,
  benchmark briefs and assets. They remain immutable evidence, never fallback
  generators or acceptance inputs. The v2 amendment keeps original brief identity,
  budgets and numeric gates while removing obsolete authoring arms and review rules.
- The old `experiments/agentic-3d/loop.mjs`, `factory.mjs`, `benchmark.mjs` and
  `paired-rerun-report.mjs` entrypoints have been removed, including the old
  factory's authoring and corpus-collection commands. Their frozen copies and all
  historical artifacts remain evidence, never runtime fallback. Shared asset-library,
  source geometry and retained reports remain in place; retained asset consumers
  import the shared library directly. The portable-template CLI and separate
  product visual-QA contract are not silently migrated by this experiment.
- **Historical runs executed the former TypeScript engine.** Every outcome,
  trace, `runtime-files.json` receipt and frozen sensing policy produced before
  the native cutover records that runtime, not the native addon. The reporters
  flag such runs as lacking a native runtime identity; do not relabel them,
  re-hash them under the new schema, or mix them into a native-runtime cohort.
  The frozen reference source at
  `/mnt/storage/simforge-native-migration/reference-source/packages` is
  read-only evidence of what those runs executed, never an import target.
