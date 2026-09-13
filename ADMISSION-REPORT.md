# M2 Admission Gate and Judge Ensemble Report

## Scope

Branch: `e2e/m2-admission`, based on `e2e/tg-rethink-land` (`72c46620`). This change is confined to the deterministic admission/review pipeline. It does not change engine controllers, trace production, actor catalogs, or corpus content.

## Deterministic provenance gate

`tools/gates/provenance_gate.py` runs after simulation as part of showcase stage `50-gate`, alongside (not instead of) the frozen training-grade gate.

For every cell it:

1. Requires `trace.header.ego.controllerProfile == "sensor-limited"`. A missing value emits `controller-profile-missing`; any other value, including `omniscient-legacy`, emits `controller-profile-untrusted`.
2. Extracts the critical event in priority order: collision, minimum TTC/path-TTC, then minimum footprint distance. The verdict records event kind, time, value, and actor IDs.
3. Resolves the intended hazard actor IDs from an explicit `brief.hazardActorIds` / `brief.provenance.hazardActorIds` declaration when present, otherwise from exact actor roles/types named by the brief and executable instance. Ambient traffic and ego are never inferred as hazards.
4. Verifies that every designated hazard exists in the executable instance and participates in the critical event. Incidental-traffic criticality emits `critical-event-wrong-actors`; an instance whose designated hazard was swapped or removed emits `designated-hazard-missing`.
5. Extracts named causal preconditions deterministically. Reduced friction and limited visibility are checked against trace-header operational conditions (constant for the clip); occlusion requires a matching recorded occlusion sample within ±0.5 s of the critical event. Missing evidence emits `causal-precondition-absent` rather than passing by assumption.

Every checked cell gets `provenance-verdict.json` atomically beside `instance.json`. The stage embeds the same structured verdict in `50-gate.json`; a provenance failure sets `firstFailure: "PROVENANCE"` and cannot reach rendering or an LLM.

## Escalation-only ensemble

`tools/gates/judge_ensemble.py` replaces the old single blind judge call. It asks four independent binary questions, each returning `yes|no`, confidence, and a one-sentence rationale:

- `physical-plausibility`
- `mechanism-match`
- `criticality-visible`
- `label-answer-consistency`

The primary is `openrouter/google/gemini-3.7-flash`. A primary `no`, confidence below 0.70, or an explicit admission-boundary marker escalates all four questions to three distinct families:

- Gemini: `openrouter/google/gemini-3.7-flash`
- GPT: `openai-codex/gpt-5.6-sol`
- Claude: `openrouter/anthropic/claude-sonnet-4.6`

The direct Anthropic adapter was tested and rejected because it dropped image inputs; the OpenRouter Claude route passed the randomized vision preflight and was used for the live run. Escalated answers are aggregated independently per question by family majority, so one family cannot dominate by verbosity or confidence scale.

Responses are cached by SHA-256 of exactly `(content hash, model, question)`. The content hash covers the review schema and question text, brief, executable instance, provenance verdict, selected frame names, and frame bytes. Cache writes are atomic. `judge-audit.json` is written beside the instance and contains every model/question answer, family, confidence, rationale, token counts, latency, response hash, and cache-hit status.

The 2D semantic oracle remains mandatory. Product acceptance is now:

`frozen+provenance gate pass AND semantic oracle match AND ensemble advisory pass AND render complete`.

The ensemble maps failures only into namespaces already governed by the frozen review contract (`scenario.plausibility`, `scenario.mechanism`, `render.camera.framing`, `judge.uncertain`). It cannot turn an oracle rejection into an acceptance or weaken any deterministic gate.

## Live verification

Working evidence is under `/tmp/m2-admission-live/`. The source pair was the existing gold-corpus-v3 cell:

`research/edge-case-corpus/gold-corpus-v3/c7b-parked-row-child/belmont-research-center__14f1c0a915d3a42f__draw-001.{instance.json,trace.json.gz}`

The historical trace was copied (not modified in the corpus) and stamped with the incoming EngineFixes contract value `header.ego.controllerProfile = "sensor-limited"`. The corrupt copy changes the executable instance's designated actor ID from `child` to `bystander`; its trace is otherwise identical.

Command:

```text
python3 tools/research/showcase/stages.py gate \
  --request /tmp/m2-admission-live/gate-request.json
```

Observed machine-readable outcomes (`/tmp/m2-admission-live/gate-output.json`):

- `good`: overall `pass: true`, provenance `pass: true`, no failure reasons.
- `corrupt`: overall `pass: false`, `firstFailure: "PROVENANCE"`, reason `designated-hazard-missing`, `missingHazardActorIds: ["child"]`.
- Both identify the recorded critical event as min-TTC 0.021967 s at t=5.48 s between `child` and `ego`; therefore the corruption is rejected specifically because the executable instance no longer contains the actor responsible for its label.

The good cell was rendered with the landed deterministic 2D trace renderer, then reviewed live through `127.0.0.1:4141/v1` with forced boundary escalation. The completed audit is `/tmp/m2-admission-live/good/judge-audit.json`; the CLI result is `/tmp/m2-admission-live/ensemble-first.json`.

Observed live ensemble evidence:

- 3 real model families and 12 decomposed responses.
- Family-majority answers: physical plausibility `yes`, mechanism match `no`, criticality visible `yes`, label-answer consistency `no`.
- Advisory verdict `false`, correctly unable to override the deterministic gate/oracle.
- The billing-bearing baseline in the live call sequence recorded 44,585 input tokens and 1,705 output tokens. A subsequent prompt-identical gateway response reported zero usage for its upstream-cached Gemini and Claude calls; the estimate below uses the conservative billing-bearing baseline.
- The immediate second identical local invocation completed in 0.15 s with 12/12 cache hits and identical aggregate answers (`/tmp/m2-admission-live/ensemble-second.json`, content hash `5a17bfb45002e6bc4513471587d52f0e9cba4a800d3077ea488f39d25a5b7177`).

## Cost estimate per scenario

Observed token counts from this live scenario:

| Path | Input | Output | Estimated external cost |
|---|---:|---:|---:|
| Primary only (4 Gemini questions) | 18,677 | 813 | about **$0.0171** |
| Escalated (12 questions, all families) | 44,585 | 1,705 | about **$0.0639 plus the internal GPT route** |
| Identical cached rerun | 0 newly billed | 0 newly billed | **$0.00** |

The estimate uses the public OpenRouter prices returned during verification: Gemini 3.7 Flash $0.75/M input and $3.75/M output; Claude Sonnet 4.6 $3/M input and $15/M output. The local gateway exposes no price for `openai-codex/gpt-5.6-sol`; it is an authorized internal route, so its dollar component is reported as unpriced rather than invented. The escalated known external component is Gemini (~$0.0171) + Claude (~$0.0468).

## Verification

- `python3 tools/gates/test_provenance_gate.py`: 4/4 pass. Covers critical-event extraction, incidental actor attribution, swapped/missing designated actor, precondition window checks, and controller-profile rejection.
- `python3 tools/research/showcase/test_showcase_tools.py`: 61/61 pass, including frozen review-contract/hash conformance.
- `node --check apps/showcase/server/pipeline.mjs` and Python bytecode compilation: pass.
- Focused product-decision smoke: an oracle-matched/rendered cell accepts with ensemble `advisoryPass: true`; the same cell rejects with `scenario.mechanism` when the ensemble's mechanism answer is `no`.
- The broader `pipeline.test.mjs` could not exercise seven fixture-dependent cases because the landed branch lacks `fixtures/evidence/golden-yale-bus-stop/trace.json.gz`; its one fixture-independent case passed. This missing base fixture is unrelated to the admission changes.
