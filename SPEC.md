# Product specification — SimForge camera fidelity adoption

> Status: approved through Genesis by Krishna Teja on 2026-09-22.

## Problem

SimForge's retained native camera path can render RGB, but its authored configuration, execution behavior and evidence do not yet form a qualified camera measurement contract. A pre-adoption implementation slice began addressing full mount rotation, camera profiles, capability rejection and measurement-versus-review behavior before the repository entered Genesis. The immediate outcome is to verify the current repository baseline, adopt that slice without overstating its evidence, and complete Phase 1 with executable gates before starting Phase 2.

This specification contains two bounded scopes derived from `SimForge_Camera_Build_Architecture.md` v0.2 §12:

- **Spec 0 — Phase 0 baseline findings:** establish what revision `998be4df40575b6c450067824f2c6aac50cd2b12` actually supports and publish the findings.
- **Spec 1 — Phase 1 configuration and capability layer:** preserve and complete the current camera-profile, rotation, negotiation and evidence slice.

Revision relationship: `998be4df40575b6c450067824f2c6aac50cd2b12` equals `origin/main` in the adopted checkout. GitHub Compare reports that it is 94 commits ahead of planning baseline `c0a0b082986940e416f4d1ed5099dd602d6e3920`, zero behind, with merge base `c0a0b082986940e416f4d1ed5099dd602d6e3920`. The local checkout is shallow/grafted, so this relationship is sourced from GitHub rather than local ancestry traversal.

## Users

- SimForge simulator engineers integrating and maintaining the native camera path.
- Perception and autonomy engineers consuming camera observations and calibration metadata.
- Calibration and qualification engineers fitting profiles and assessing evidence.
- Repository maintainers reviewing claims, generated schemas, tests and manifest compatibility.

## Functional requirements

### Spec 0 — Phase 0 baseline findings

- FR-001: Publish `docs/engineering/camera-baseline-findings.md` pinned to working revision `998be4df40575b6c450067824f2c6aac50cd2b12`, planning baseline `c0a0b082986940e416f4d1ed5099dd602d6e3920`, and their verified GitHub relationship.
- FR-002: Trace authored yaw, pitch and roll from scenario schema through TypeScript lowering, native wire serialization and service-side attach consumption, including all coordinate-frame sign conversions.
- FR-003: Identify the current ownership and execution role of the existing `render-core`, render service, sensors and FFI crates, including the changed `episode` operations, `products.rs`, `projection.rs` and expanded `capture.rs` surfaces found after the planning baseline.
- FR-004: Record which camera settings are consumed, ignored or presentation-only on the retained native path.
- FR-005: Verify the selected render profile, automatic metering and temporal/cinematic defaults for review and dataset fidelity modes; for the Sensor path, record the service RGB readback texture format, transfer function and bit depth rather than inferring encoding from `Tonemapping::None`.
- FR-006: Record which RGB, depth, instance, semantic and motion-vector passes are implemented by lower layers and which are reachable through the retained adapter.
- FR-007: Verify current motion-vector behavior before any optical-flow truth claim.
- FR-008: Verify current batch/CLI packaging behavior rather than carrying the historical failure forward as fact.
- FR-009: Identify the existing TypeScript-to-native/FFI integration mechanism; no speculative new bridge or crate may be introduced.
- FR-010: Classify checkpoint/resume camera state as an Add capability unless current source proves an implementation.
- FR-011: Classify actual-versus-reported calibration as an Add capability unless current source proves a separated physical and consumer-facing calibration path.

### Spec 1 — Phase 1 configuration and capability layer

- FR-012: Represent a versioned camera profile with an explicitly generic-uncalibrated default and preserve it through scenario serialization and render-intent construction. The profile separates `outputStage: 'linear' | 'processed'` from `encoding: { transfer: 'linear' | 'srgb'; bitDepth: number }`; the generic values come from the FR-005 Phase 0 finding and are not assumed.
- FR-013: Propagate complete camera mount orientation, including roll, through the retained native attachment path with verified frame/sign semantics.
- FR-014: Negotiate camera profile requirements against the selected engine and reject unsupported combinations, including rolling shutter, PTC noise and raw output, without silent downgrade.
- FR-015: Use the existing `RenderProfile::Sensor` path for dataset/measurement capture and keep cinematic review behavior separate.
- FR-016: Record requested and effective camera profile information, including separate output stage and encoding, fidelity mode, approximations and differences in native evidence.
- FR-017: Move native render-manifest camera evidence to `simforge.native-render-manifest/v2`, with mandatory validator-enforced camera-profile fields; if diagnostics gain mandatory camera fields, move them to `simforge.native-run-diagnostics/v2` as well. Retain read-only v1 acceptance that classifies legacy artifacts as `camera-profile-evidence: absent (pre-v2)` instead of silently passing them as complete or rejecting them as malformed. Schema declaration or default insertion alone is not enforcement.
- FR-018: Implement CAM-01-CAP-005 as distinct actual and reported calibration views so changing reported calibration does not change image formation and privileged actual calibration does not leak to normal consumers.
- FR-019: Add a geometric fixture with nonzero yaw, pitch and roll plus an off-centre principal point, proving the selected path's projection and exported calibration agree.
- FR-020: Preserve backward compatibility for existing authored dash cameras by materializing the generic profile through schema defaults and generated JSON Schema.

## Non-functional requirements

- NFR-001: Every implementation task from HumanLayer task `upgrade-camera-sensor-in-simforge-simulator-sftpd9` must use Genesis specification, approved planning, bounded tasks, executable gates and checkpoints.
- NFR-002: No capability may advance beyond `declared`, `integrated`, `exercised`, `qualified` or `device-fitted` without evidence for that exact level.
- NFR-003: Unsupported, approximated, skipped, untested and failed outcomes must remain distinguishable in machine-readable evidence.
- NFR-004: Dataset capture must not silently apply cinematic temporal effects or automatic metering.
- NFR-005: Existing scenario and render package typechecks must pass; camera changes must not weaken strict schema parsing.
- NFR-006: Generated schema changes must be reproducible from the checked-in generator and reviewed separately from hand-written behavior changes.
- NFR-007: The implementation must reuse existing repository modules and standard facilities before adding packages, crates or dependencies.

## Constraints

- Build Architecture v0.2 is authoritative. Plan approval is blocked until both local copies match the approved artifact SHA-256 `5f22d10f75cc4afaa7a8822f9ae3c6be3e8438765d185ca3234629e96065d62d`, contain 734 lines, identify document version 0.2 on line 3 and contain §12 at line 669.
- The preserved uncommitted 12-file diff predates Genesis adoption and is partial evidence only; it must not be discarded or represented as passing.
- Module placement follows existing `render-core`, service, sensors and FFI crates rather than the v0.1 proposed standalone camera-model layout.
- Phase 4 reuses the existing `RenderProfile::Sensor`; no duplicate linear profile is introduced.
- Checkpoint/resume and calibration are Add capabilities.
- NuRec/splat integration is outside this implementation scope.
- Camera observations, privileged truth and presentation derivatives remain separate information channels.
- Product implementation is paused until this specification and its generated plan receive explicit human approval through Genesis.

## Non-goals

- Implement rolling-shutter image formation, PTC detector noise, ISP replay, lossless observation export or truth sidecars in Spec 1.
- Claim a real-device camera match, EMVA compliance or task-transfer fidelity.
- Add NuRec, Gaussian-splatting or a new renderer.
- Implement checkpoint/resume state or the calibration toolchain beyond the Phase 1 actual-versus-reported contract.
- Commit or publish the preserved implementation slice before all Spec 1 gates pass.

## Acceptance criteria

### Spec 0 acceptance

- AC-001: `docs/engineering/camera-baseline-findings.md` answers FR-001 through FR-011 with source file/line evidence, commands used and explicit `confirmed`, `refuted` or `unverified` status, including the Sensor-path RGB texture format, transfer and bit depth required by FR-005.
- AC-002: A service-side test or equivalent executable proof demonstrates that `rollDeg` reaches and affects the attach-path mount rotation; TypeScript shape propagation alone does not satisfy this criterion.
- AC-003: The baseline report records `998be4df` as `origin/main`, 94 commits ahead of `c0a0b08`, and cites the GitHub comparison because local history is shallow.

### Spec 1 acceptance

- AC-004: Scenario round-trip tests prove the generic camera profile, including separate output-stage and encoding fields populated from the Phase 0 finding, survives authoring, serialization, render-spec building and render-intent parsing.
- AC-005: Capability tests prove the native engine accepts its implemented generic profile and rejects rolling shutter, PTC noise, raw output and unsupported projection families with stable machine-readable reasons. Projection-family rejection is new work and is not present in the preserved implementation slice.
- AC-006: The geometric fixture proves nonzero yaw, pitch and roll plus an off-centre principal point on the selected native path.
- AC-007: CAM-01-CAP-005 tests prove reported-only perturbation changes exported consumer calibration while leaving image-formation calibration unchanged and preventing privileged leakage.
- AC-008: Native v2 manifest validation rejects absent or inconsistent mandatory camera-profile evidence and records review-mode profile bypass as an explicit difference; read-only v1 parsing returns the explicit classification `camera-profile-evidence: absent (pre-v2)`.
- AC-009: Dataset mode selects the existing sensor profile with automatic metering disabled; review mode remains cinematic and records that distinction.
- AC-010: Scenario and render package typechecks pass, all relevant focused tests pass, generated JSON Schema is current, and `git diff --check` passes against the checkpointed source hash.
- AC-011: The first Spec 1 checkpoint remains explicitly partial until AC-002, AC-006, AC-007 and AC-008 pass; passing unrelated tests cannot promote it.

## Risks

- Roll may carry the wrong sign across authored forward/up/left, native forward/right/up and Bevy frames. Mitigation: service-side geometric fixture, not only object-shape assertions.
- Manifest fields may parse only because defaults fill missing values. Mitigation: negative validator tests for absent and inconsistent evidence.
- A generic profile may conflate a no-tonemap stage with its storage encoding. Mitigation: Phase 0 measures the service readback format, transfer and bit depth; the profile stores stage and encoding separately.
- Mandatory camera evidence could be added under a legacy schema identifier and make old artifacts appear complete. Mitigation: emit v2, enforce mandatory fields and classify read-only v1 evidence as absent pre-v2.
- Generated JSON Schema creates a large mechanical diff. Mitigation: regenerate deterministically and review behavioral source separately.
- Existing uncommitted work can be mistaken for approved implementation. Mitigation: preserve it as partial checkpoint evidence and prohibit commit until gates pass.
- Stale local v0.1 architecture can be cited accidentally. Mitigation: synchronize v0.2 before plan approval and retain the temporary-authority record until then.

## Open questions

- Build Architecture v0.2 must be synchronized and hash-verified before plan approval.
- Phase 0 checklist items 0.10 (`fixedTimestepSeconds` versus irregular union `tickHz`) and 0.11 (`sceneRevision`/`rigRevision` validation) are deliberately deferred to Spec 2 and are not acceptance requirements for Spec 0 or Spec 1.
