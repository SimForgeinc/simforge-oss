# Camera baseline findings

This Phase 0 record describes revision `998be4df40575b6c450067824f2c6aac50cd2b12`, not the uncommitted Phase 1 TypeScript slice in the working tree. Every finding uses the specification status vocabulary: `confirmed`, `refuted`, or `unverified`. A separately stated blocker explains why an unverified finding could not be exercised.

## FR-001: revision pin and planning relationship

**Status: confirmed.**

- Working revision `998be4df40575b6c450067824f2c6aac50cd2b12` was exactly `origin/main` when inspected on 2026-09-22.
- Planning baseline is `c0a0b082986940e416f4d1ed5099dd602d6e3920`; its abbreviated merge-base identity is `c0a0b08`.
- GitHub Compare reports working revision `998be4df` as 94 commits ahead of `c0a0b08` and zero commits behind, with merge base `c0a0b082986940e416f4d1ed5099dd602d6e3920`.
- The relationship is cited from `https://github.com/SimForgeinc/simforge-oss/compare/c0a0b082986940e416f4d1ed5099dd602d6e3920...998be4df40575b6c450067824f2c6aac50cd2b12` because the local checkout is shallow and cannot establish the complete 94-commit ancestry by local traversal alone.

Command evidence: `git rev-parse HEAD`, `git rev-parse origin/main`, `git merge-base 998be4df c0a0b08`, and the GitHub Compare response recorded in Genesis before this task.

## FR-002 / checklist 0.1: authored rotation, native wire, service attach, and roll

**Status: refuted end to end; confirmed for the service's intermediate mount rotation, attach precedence, ground resolution, and yaw/pitch direction.**

- `SensorRotationSchema` authors radians in actor-local `+X` forward, `+Y` up, `+Z` left, applied yaw about `+Y`, pitch about `+Z`, then roll about `+X`. `buildCanonicalRenderSpec` copies that mount unchanged into each render source.
- At the pinned revision, `NativeSensorAttach` contains only `yawDeg` and `pitchDeg`; `attachment()` lowers position to wire `forward/right/up` as `[x, -z, y]`, negates authored yaw into the wire's clockwise/CARLA sense, preserves pitch, and drops authored roll entirely. The uncommitted Phase 1 slice adds `rollDeg`, but that is not baseline evidence.
- `NativeServiceClient` serializes the `render_bundle` object with `@msgpack/msgpack`; Rust `CameraAttach` uses `serde(rename_all = "camelCase")`, so wire `yawDeg`, `pitchDeg`, and any future `rollDeg` deserialize to the service fields. The Rust protocol already accepts `roll_deg` with a zero default.
- `renderer/service/src/proto.rs` defines `CameraAttach.roll_deg` as degrees around local forward `+X` after yaw and pitch.
- `renderer/service/src/server.rs::resolve_pose` ignores explicit `eye` and `target` whenever `attach` is present. It resolves the current host actor and uses the attachment origin.
- `renderer/service/src/server.rs::resolve_sensor_mount` resolves actor height by precedence: nonzero authored actor Y, then frame `ground_y`, then sampled mesh ground. It converts wire `[forward, right, up]` to Bevy `[forward, up, right]`, applies actor yaw, and passes yaw, pitch, and `roll_deg` into `SourceRotation::MountYawPitchRoll` with `FrameBasis::Rig`. `source_to_bevy` negates wire yaw once more, restoring the authored yaw direction; pitch is unchanged. Preserving authored roll across the left-to-right reflection would require a negated wire roll, but the pinned TypeScript boundary sends none.
- The intermediate mount quaternion has the documented positive-roll sign: at zero yaw/pitch, `+10 deg` about local `+X` rotates `+Y` toward `+Z`.
- The service then collapses that quaternion to `target = origin + 50 * (rotation * +X)` and calls `SceneApp::set_pose(eye, target)`. Roll about `+X` does not change `rotation * +X`, and the eye/target API has no up vector or orientation quaternion. Consequently, a nonzero authored roll cannot tilt the rendered horizon. `look_at_actor` also bypasses mount orientation entirely by targeting the host origin plus `+Y`.
- Executable proof: `renderer/service/src/server.rs::tests::camera_attach_roll_is_lost_when_service_reduces_mount_to_eye_target` proves the positive intermediate sign, proves the forward target is invariant under roll, and checks the pre-test production source contains the exact attach consumption, forward reduction, and `set_pose` boundary. It passes under `cargo test --manifest-path renderer/Cargo.toml -p service`. This is an executable source-bound refutation, not a rendered-horizon qualification.

Source evidence: `packages/scenario/src/schema/v2/sensors.ts:8`, `packages/scenario/src/render-spec-builders.ts:142`, `packages/render/src/native/camera-schedule.ts:13`, `packages/render/src/native/camera-schedule.ts:81`, `packages/render/src/native/service-client.ts:138`, `packages/render/src/native/service-client.ts:162`, `renderer/service/src/proto.rs:21`, `renderer/service/src/server.rs:838`, `renderer/service/src/server.rs:891`, `renderer/service/src/server.rs:916`, `renderer/render-core/src/coordinates.rs:34`, and `renderer/render-core/src/engine.rs:3891` at the pinned revision.

**Planning consequence:** AC-002 is refuted. Do not activate or adopt `CAM-S1-CAP004` from the preserved TypeScript slice. `CAM-S1-CAP006` must classify full mount rotation as approximated/unsupported rather than supported. A separate, human-approved Spec 1 renderer/service task must replace the eye/target-only boundary with an orientation-preserving camera pose and prove the rendered horizon sign before full mount rotation can be claimed.

## FR-003: current renderer ownership and post-baseline surfaces

**Status: confirmed.**

- `renderer/render-core` owns the reusable retained Bevy `SceneApp`, camera registration, render profiles, lighting, pass targets/readback, frame identity, device interop, and the consumer-independent product vocabulary. It is the rendering mechanism, not a camera-device model crate.
- `renderer/service` owns the V5 request/response protocol, retained scene/rig state, actor-ground attachment resolution, pass publication, and episode RPC behavior. `episode.rs`, added after planning baseline `c0a0b08`, owns reset, action advance, termination, trajectories, consumer cadence, and observations.
- `renderer/sensors` owns the offline capture harness and physical/derived sensor algorithms. Since the planning baseline, `capture.rs` expanded substantially across multimodal capture, scene/BVH setup, pass collection, and output writing; `projection.rs` added calibrated projection resizing that preserves field of view.
- `renderer/render-core/src/products.rs`, added after the planning baseline, owns consumer output intent (`ConsumerSpec`, RGB/depth products, trajectory sampling, lidar/radar encodings) and validates combinations independently of lighting implementation.
- `renderer/ffi` is an existing in-process C ABI over the same service protocol and `ServiceState`. It accepts JSON requests and shares host output through the same shared-memory ring; Linux GPU-interoperability builds can transfer exported device handles. It does not justify inventing another bridge or camera crate.

Source evidence: `renderer/render-core/src/engine.rs:1`, `renderer/render-core/src/products.rs:1`, `renderer/service/src/server.rs:198`, `renderer/service/src/episode.rs:1`, `renderer/sensors/src/capture.rs:85`, `renderer/sensors/src/projection.rs:1`, and `renderer/ffi/src/lib.rs:1`. The changed-surface check was `git diff --stat c0a0b082986940e416f4d1ed5099dd602d6e3920..998be4df40575b6c450067824f2c6aac50cd2b12 -- renderer/service/src/episode.rs renderer/render-core/src/products.rs renderer/sensors/src/projection.rs renderer/sensors/src/capture.rs`.

## FR-004: retained-native camera settings inventory

**Status: confirmed.**

- **Consumed for image formation:** source width and height allocate the target; horizontal FOV plus width/height are converted to vertical FOV; mount position, host actor yaw, authored yaw, and authored pitch form the attach pose; host visibility controls per-camera host exclusion. All camera `nearM` values are collapsed to one scene minimum and all `farM` values to one scene maximum, so the service consumes global extrema rather than each camera's requested pair.
- **Consumed for timing/packaging, not optics:** source `fps` selects capture timestamps and encoder rate. The retained service receives a simulation tick and has no per-camera exposure-time/readout-time model at this boundary.
- **Ignored or silently substituted:** authored roll is omitted by pinned `NativeSensorAttach`; per-camera near/far distinctions are replaced by scene-wide extrema; the retained adapter requests only RGB even though lower layers can register ID/depth; there is no principal-point, skew, distortion, shutter, ISO/gain, white-balance, or noise input on `RenderCameraAttributesSchema`.
- **Presentation-only:** every pinned native run selects `profile: cinematic`, defaults `autoMeter` on, and writes camera pixels only to fixed libx264/yuv420p MP4 derivatives. Requested top-level video codec/container/quality do not configure `startEncoder`; its H.264/MP4 settings are fixed. These videos are review artifacts, not raw observations.

Source evidence: `packages/scenario/src/render-spec.ts:154`, `packages/render/src/native/camera-schedule.ts:62`, `packages/render/src/native/camera-schedule.ts:87`, `packages/render/src/native/camera-schedule.ts:135`, and `packages/render/src/native/engine.ts:279` at the pinned revision.

## Checklist 0.2: existing identity, readiness, extrinsics, and history contracts

**Status: confirmed.**

- `renderer/render-core/src/engine.rs::FrameIdentity` binds one capture to caller-supplied `sim_tick`, current `scene_revision`, current `rig_revision`, and one GPU submission `generation`. `CapturedFrame` returns one such identity with every requested host pass and device output.
- `renderer/render-core/src/engine.rs::DeviceReady` identifies one device output by `stream`, `slot`, and `generation`. The service publishes it per sensor in `render_bundle` responses.
- `renderer/render-core/src/coordinates.rs::PolicyFromSensor` is a row-major 4x4 affine transform from native sensor coordinates to policy forward/left/up coordinates at the host actor origin. `ResolvedSensorPose::policy_relative_to` derives it from the exact resolved sensor and host poses, so consumers need not re-derive mount angles.
- `renderer/service/src/proto.rs::EpisodeImageHistory` stores `time_seconds`, the exact `FrameIdentity`, and all shared-memory `FrameRecord` entries for an authored pre-roll sample. Episode reset renders each retained history index independently; the history is not a list of aliases to the current submission.

These are useful Phase 2 carriers, but this Phase 0 task does not change or extend them.

Source evidence: `renderer/render-core/src/engine.rs:727`, `renderer/render-core/src/engine.rs:760`, `renderer/render-core/src/coordinates.rs:61`, `renderer/service/src/proto.rs:287`, and `renderer/service/src/proto.rs:428` at the pinned revision.

## FR-005 / checklist 0.3: Sensor-path RGB texture format, transfer, bit depth, and metering

**Status: confirmed.**

- `renderer/render-core/src/engine.rs::SceneApp::add_camera` creates every RGB readback target as `TextureFormat::Rgba8UnormSrgb`.
- The service publishes RGB as four bytes per pixel (`rgba8`) through `plan_camera_passes`; the alpha channel is present in readback and ignored by coverage calculations.
- The retained TypeScript adapter selects `profile: cinematic` for every pinned native run and defaults service `autoMeter` to true; there is no separate dataset/measurement selection at this revision. `RenderProfile::Sensor` exists in render-core but is not selected by this adapter baseline.
- `RenderProfile::Sensor` applies fixed exposure and `Tonemapping::None`, with no temporal or cinematic post effects. However, the target itself is sRGB, so the stored eight-bit RGB channels are sRGB-transfer encoded, not linear-light float samples. The existing “linear output” comment describes the absence of a filmic tone map, not the transfer function of the readback bytes.
- The source-bound profile values for Spec 1 are therefore `outputStage: linear` and `encoding: { transfer: srgb, bitDepth: 8 }`. Here `linear` identifies the no-tonemap/no-colour-grading RGB stage before storage encoding; it does not claim that the stored bytes have a linear transfer. Alpha remains an 8-bit transport channel and does not change the RGB bit-depth declaration. This is not raw sensor output.
- `renderer/service/src/server.rs::auto_meter` populates `Lighting.meter_view` from the first service camera's resolved eye-to-target direction, vertical FOV, and width/height aspect only when service `auto_meter` is enabled, atmosphere is enabled, and the authored lighting did not already provide `meter_view`. It recomputes only after a material heading, FOV, or aspect change and advances lighting in place. Sensor-profile fixed exposure does not by itself disable this service-side meter; callers must set `auto_meter=false` for stable dataset measurement.

Source evidence: `renderer/render-core/src/engine.rs:2942`, `renderer/render-core/src/profiles.rs:341`, `renderer/service/src/server.rs:310`, and `renderer/service/src/server.rs:1133` at the pinned revision.

## Checklist 0.4: capture width, height, and fps defaults

**Status: confirmed.**

`packages/scenario/src/render-spec-builders.ts::buildCanonicalRenderSpec` resolves camera capture fields independently with this precedence:

1. Explicit submission video field (`input.video.width`, `height`, or `fps`).
2. The matching source in the validated `extensions["simforge.render-defaults"]` document, read by `templateRenderDefaults` and `renderDefaultSource`.
3. Renderer defaults: width `1280`, height `720`, fps `24`.

The template carrier is parsed as a complete `RenderSpecV3`; a present but invalid carrier throws rather than silently falling back. This establishes the baseline precedence that an effective camera configuration must report.

Source evidence: `packages/scenario/src/render-defaults.ts:21` and `packages/scenario/src/render-spec-builders.ts:127` at the pinned revision.

## FR-006 and FR-007 / checklist 0.5: reachable passes and motion vectors

**Status: refuted as a retained-service output.**

Render-core and sensors implement RGB, reverse-Z depth, instance ID, and semantic derivation. The retained camera service can register `rgb`, `id`, and `depth`, derive semantic bytes from ID, and publish those four names. The pinned TypeScript adapter nevertheless requests only `['rgb']` and advertises only `sensor.rgb` among camera products, so depth, instance, and semantic are lower-layer implementations but unreachable through the retained adapter. Render-core playback also has internal motion-vector prepass and metric machinery, but the retained camera service contract has no motion-vector `PassSet` field, parser name, readback publication, or wire format.

Motion vectors therefore exist as renderer-internal capability but are unsupported as a negotiated native sensor product. They must not be advertised until a pass type, capture/readback route, wire format, capability declaration, and evidence contract are added and exercised together.

Source evidence: `renderer/render-core/src/engine.rs:678`, `renderer/service/src/server.rs:993`, `renderer/service/src/server.rs:1133`, and `packages/render/src/native/engine.ts:341` at the pinned revision.

## FR-008 / checklist 0.6: batch packaging

**Status: unverified at runtime on this host; source implementation confirmed.**

Batch packaging is available on the current head through `packages/cli/src/commands/batch.ts`. The CLI builds deterministic sweep cells, writes per-cell state and result artifacts, supports bounded concurrency, resumes completed cells when inputs match, and recomputes with `--force`. `packages/cli/src/__tests__/cli-smoke.test.ts` contains the source-bound test `runs a resumable batch and reproduces every cell on the second pass`, which asserts zero first-pass resumes, complete second-pass resumes, and identical trace digests after forced recomputation.

This route is suitable for the later T05 sweep, subject to the camera capability and evidence gates; Phase 0 does not imply camera-fidelity qualification.

Source evidence: `packages/cli/src/commands/batch.ts:72` and `packages/cli/src/__tests__/cli-smoke.test.ts:390` at the pinned revision.

## FR-009: existing TypeScript-to-native integration

**Status: confirmed.**

The retained TypeScript adapter already uses `NativeServiceClient` and `startNativeRenderService`: it launches the existing `native-render-service` executable, sends length-prefixed MessagePack V5 requests over the platform endpoint, and reads frame payloads from the service-owned shared-memory ring. `@msgpack/msgpack` is the object serializer; there is no per-camera N-API bridge. The separate existing `renderer/ffi` crate exposes the same `ServiceState` and protocol as a C ABI for in-process hosts, using JSON control messages and the same shared-memory output. These are the integration mechanisms to reuse; no new bridge or crate is warranted.

Source evidence: `packages/render/src/native/service-process.ts:119`, `packages/render/src/native/service-client.ts:1`, `packages/render/src/native/service-client.ts:138`, `packages/render/src/native/service-client.ts:162`, and `renderer/ffi/src/lib.rs:1` at the pinned revision.

## FR-010: checkpoint/resume camera state

**Status: confirmed as an Add capability.**

The source contains resumable CLI batch-cell bookkeeping and episode image history, but no serialized camera runtime state covering exposure/meter history, temporal buffers, rolling-shutter progress, noise RNG, or other camera-device state. `RenderProfile::Sensor` deliberately removes temporal effects; cinematic TAA/motion effects remain renderer state rather than an exportable checkpoint contract. Checkpoint/resume camera state must therefore be classified `Add`, not credited from batch resume or `EpisodeImageHistory`.

Source evidence: `packages/cli/src/commands/batch.ts:72`, `renderer/service/src/proto.rs:428`, `renderer/render-core/src/profiles.rs:290`, and `renderer/render-core/src/engine.rs:1694` at the pinned revision. Search command: `git grep -n -i "checkpoint\|resume\|serialize.*camera\|camera.*state" packages renderer`.

## FR-011: actual-versus-reported calibration

**Status: confirmed as an Add capability.**

The pinned camera contract has one width, height, FOV, near/far set and one effective service projection. It has no separate physical/image-formation calibration and consumer-facing reported calibration, no privileged actual-calibration channel, and no isolation test showing that reported-only perturbation leaves rendered pixels unchanged. Existing `PolicyFromSensor` carries extrinsics, not dual calibration views. CAM-01-CAP-005 actual-versus-reported calibration is therefore `Add`.

Source evidence: `packages/scenario/src/render-spec.ts:154`, `renderer/render-core/src/engine.rs:716`, `renderer/render-core/src/coordinates.rs:61`, and `renderer/service/src/proto.rs:66` at the pinned revision. Search command: `git grep -n -i "reported.*calibration\|actual.*calibration\|CameraCalibrationSet" packages renderer`.

## Checklist 0.7: browser engine camera path

**Status: confirmed, with a separate implementation boundary.**

`packages/render/src/web/capture.ts::captureBrowserArtifacts` lowers `RenderSpecV3` to browser passes, composes each sensor world matrix from actor heading plus authored yaw/pitch/roll, and applies the resulting position, up vector, look direction, aspect, FOV, and near/far planes to a Three.js `PerspectiveCamera`. RGB is rendered offscreen to RGBA and camera pixels are emitted only through each camera's encoded video stream; camera frame archives are deliberately absent. Depth, semantic, and instance passes use separate readback paths.

The browser path does not call the retained native service and therefore does not repair the native eye/target roll loss. Browser and native execution coverage must remain distinct in capability claims and tests.

Source evidence: `packages/render/src/web/capture.ts:70`, `packages/render/src/web/capture.ts:207`, and `packages/render/src/web/capture.ts:263` at the pinned revision.

## Checklist 0.8: CARLA adapter tests and skip conditions

**Status: confirmed for local contract tests; unverified because the live comparator gate is blocked.**

- `adapters/carla-exec/tests/test_local.py` covers package/schema pinning, render-intent digest parity, front-rig identity, preflight/probe cleanup, tick-barrier behavior, sensor-host selection, and artifact-manifest shape.
- `adapters/carla-exec/tests/test_runtime.py` covers mocked runtime behavior including camera attributes, exact-frame sensor synchronization, camera stream encoding, render-spec support, parity tolerance, and actor/sensor lifecycle behavior.
- Neither file contains `pytest.mark.skip`, `skipif`, or `xfail`, and the adapter contains no environment-conditioned live-CARLA comparator test. The tests use fake or monkeypatched CARLA-facing objects and do not prove behavior against a running CARLA server.

Accordingly, the ordinary adapter test suites have no skip condition to report, while any live same-scene CARLA comparator remains blocked on separately provisioned runtime infrastructure and an explicit test entry point.

Source evidence: `adapters/carla-exec/tests/test_local.py:14`, `adapters/carla-exec/tests/test_local.py:127`, `adapters/carla-exec/tests/test_runtime.py:166`, `adapters/carla-exec/tests/test_runtime.py:881`, and `adapters/carla-exec/tests/test_runtime.py:1857` at the pinned revision.

## Checklist 0.9: ffmpeg call sites and colour metadata

**Status: confirmed; native encoder risk remains open.**

- `packages/render/src/native/engine.ts::startEncoder` pipes `rgba` into libx264/yuv420p but sets no input or output colour range, matrix, primaries, or transfer metadata. Its conversion can therefore inherit ffmpeg defaults rather than the source-bound sRGB/8-bit declaration.
- `packages/cli/src/commands/drive.ts::createEncoder`, `studio/worker/executor.ts`, `packages/evaluation/src/uploaded-video-run.ts`, and `packages/evaluation/scripts/render-uploaded-video-overlay.py` also encode or transcode without a complete explicit colour contract.
- `adapters/carla-exec/simforge_oss_carla_exec/runtime/backend.py::_CameraStreamEncoder` is the exception: it explicitly tags BT.709 colorspace, primaries, and transfer for CARLA presentation video, though it still does not explicitly set colour range.
- `adapters/carla-exec/simforge_oss_carla_exec/runtime/sensor_video.py` and its generic `_ffmpeg_common` path use rgb24/yuv420p without explicit matrix/range/transfer metadata.
- Decoder-only evaluation paths use ffmpeg for PNG/RGB extraction and preserve timestamp checks, but decoding does not establish the provenance of an upstream encoder's colour conversion.

Native encoded video is therefore a derivative product whose colour conversion is not yet source-bound. It must not be used as proof that Sensor-path readback is linear or raw; manifest v2 should distinguish the `Rgba8UnormSrgb` readback contract from later video encoding.

Source evidence: `packages/render/src/native/engine.ts:141`, `packages/cli/src/commands/drive.ts:253`, `studio/worker/executor.ts:258`, `adapters/carla-exec/simforge_oss_carla_exec/runtime/backend.py:446`, and `adapters/carla-exec/simforge_oss_carla_exec/runtime/sensor_video.py:30` at the pinned revision.

## Deferred Phase 0 checklist items

Items 0.10 (`fixedTimestepSeconds` versus irregular union `tickHz`) and 0.11 (`sceneRevision`, `rigRevision`, and `generation` validation) are deliberately deferred to Genesis Spec 2 by `DECISION-573f1074`. They are not investigated or claimed complete here.

## Commands used

The inspection used revision-pinned `git show 998be4df40575b6c450067824f2c6aac50cd2b12:<path>` reads plus these source searches and executable gates:

```bash
git grep -n "roll_deg\|rollDeg\|rollRad" packages renderer
git grep -n "struct FrameIdentity\|struct DeviceReady\|PolicyFromSensor\|EpisodeImageHistory" renderer
git grep -n "meter_view\|Rgba8Unorm\|TextureFormat::" renderer/render-core/src/engine.rs
git grep -n "capture?.width\|templateRenderDefaults\|renderDefaultSource" packages
git grep -rn -i "motion.vector\|velocity_buffer\|MotionVector" renderer packages
git grep -n "ffmpeg" packages adapters
cargo test --manifest-path renderer/Cargo.toml -p service
pnpm --filter @simforge-oss/cli exec vitest run src/__tests__/cli-smoke.test.ts -t "runs a resumable batch"
```

The service suite and documentation content gate passed. The focused batch command was collected but skipped because the private `yale-st-palo-alto-ca` map bundle was not installed; the public registry exposes only `richmond-field-station`. The batch implementation is therefore source-confirmed, while execution of this map-bound fixture is unverified on this host rather than reported as a pass.

## Gate conclusion

The baseline is sufficient to source-bind the existing contracts and the Sensor-path encoding, but AC-002 is refuted: the service consumes `roll_deg` only into an intermediate quaternion and loses it at the eye/target camera boundary. No Phase 1 work may claim full mount rotation or adopt `CAM-S1-CAP004` until the separately approved renderer/service correction exists and passes an orientation-preserving rendered-horizon proof.
