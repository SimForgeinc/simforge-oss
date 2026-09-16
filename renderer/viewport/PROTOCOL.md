# Native viewport IPC v1

The interactive viewport is separate from the headless sensor `render_bundle`
service: that subsystem has its own transport and its own frame ring, and
nothing in this document applies to it.

Transport: newline-delimited JSON, host → viewport on stdin, viewport → host
on stdout. Electron owns the child process and treats stdout events as
authoritative. The viewport's own logs go to **stderr**; stdout carries
nothing but events.

Casing: commands are kebab-case names, and **every field in both directions is
camelCase**. One casing across the boundary, enforced by
`protocol::tests::commands_use_camel_case_fields` and
`protocol::tests::events_carry_camel_case_identity`; snake_case payloads are
rejected as malformed rather than silently half-accepted.

Map identity is immutable and is *proved*, not declared: `load-map` states
which release the host believes a root holds, and the viewport verifies that
against `.map-release.json` and the bytes on disk before it loads anything
(see "Identity and verification").

## Host → viewport commands

```json
{"command":"load-map","mapRoot":"/absolute/native/profile","mapVersionId":"...","releaseDigest":"..."}
{"command":"camera","position":[0,25,45],"target":[0,0,0]}
{"command":"pointer-ray","origin":[0,1,2],"direction":[0,-1,0],"layers":["actors","ground","map-static"],"maxHits":8}
{"command":"pointer-button","button":"primary","state":"pressed","x":0.2,"y":-0.1}
{"command":"key","key":"Escape","state":"pressed","modifiers":[]}
{"command":"selection","ids":["map-static:412:UtilityPole_3"]}
{"command":"overlay","id":"coverage","visible":true,"payload":{"points":[],"lines":[]}}
{"command":"resize","width":1600,"height":1000,"pixelRatio":1,"x":320,"y":180}
{"command":"debug-device-lost","reason":"fault injection"}
{"command":"quit"}
```

* `load-map` — verify identity against the root and start the progressive
  load. `mapRoot` is a host filesystem path and is supplied by the Electron
  main process, never by page script: the renderer sends identity only and the
  shell resolves the root under the cache root it owns. A second `load-map`
  for the same root and release is a no-op; a different root is rejected
  (`map_root_immutable`), because the process's asset root is fixed at launch.
* `camera` — set the eye and look-at target. Answered with `camera-state`.
* `pointer-ray` — pick with a world-space ray the host derived from the pose
  the viewport reported. Answered with `picked`. `layers` may be empty, which
  means all layers; `maxHits` defaults to 8.
* `pointer-button` — a pointer event in normalized device coordinates
  (x/y in [-1, 1], +y up). `primary`+`pressed` unprojects through the live
  camera, answers `picked`, and sets the selection to the nearest hit
  (`selection-changed`). Other buttons and the `released` transition are
  accepted and change nothing: the editor owns context menus and drag
  gestures.
* `key` — forwarded keyboard input. `Escape` clears the selection;
  `w`/`a`/`s`/`d` and the arrow keys nudge the camera and answer with
  `camera-state`. Other keys and `released` are accepted and ignored;
  `modifiers` is accepted and not interpreted.
* `selection` — set the selection. Answered with `selection-changed`.
* `overlay` — show or hide an overlay. `payload` is **opaque**: the editor
  owns its schema. The viewport draws `points` (as spheres) and `lines` (as
  line strips) when they are present, preserves the rest untouched, and echoes
  the id and visibility in `overlay-state`.
* `resize` — set the size, device pixel ratio and, when `x`/`y` are given, the
  screen position of the native window. Answered with `resized`. This is how
  the window is kept over the editor's viewport region (see "Compositing").
* `debug-device-lost` — **fault injection.** Drives the same device-lost
  producer a real wgpu device-lost callback drives. It ships in the binary
  because the recovery path is otherwise reachable only by breaking a GPU.
* `quit` — exit cleanly.

An unrecognized command is **never** ignored. It produces an `error` event
whose `code` distinguishes the cases: `malformed_json`, `missing_command`,
`unknown_command`, `malformed_command`, and `command_not_implemented` for a
command this document declares for v2.

## Viewport → host events

```json
{"event":"starting","mapVersionId":"","releaseDigest":"","renderer":"native-wgpu-bevy","awaiting":"load-map"}
{"event":"manifest-ready","mapVersionId":"...","releaseDigest":"...","canonicalDigest":"...","name":"richmond-field-station","version":"v11","members":1963,"totalBytes":1132216952,"verified":["master.gltf"],"sizeCheckedMembers":1963,"drawableNodes":983,"coarseNodes":102,"budgetBytes":2147483648,"coarseBudgetBytes":171798688}
{"event":"coarse-ready","mapVersionId":"...","elapsedMs":546,"residentBytes":171798564,"nodes":102}
{"event":"interactive","mapVersionId":"...","elapsedMs":601,"residentBytes":171798564,"pipelinesPending":0,"materialsPending":0}
{"event":"complete","mapVersionId":"...","elapsedMs":3852,"residentBytes":898415932,"peakResidentBytes":898415932,"budgetBytes":2147483648,"residentNodes":608,"budgetSkippedNodes":0,"budgetSkippedBytes":0,"verified":["master.gltf","geometry.bin"]}
{"event":"camera-state","position":[40,260,40],"target":[0,0,0],"fovYRad":0.7853982,"aspect":1.7777778,"nearM":0.1,"farM":1000.0}
{"event":"picked","hits":[{"layer":"ground","id":"ground:12:Terrain_0","distanceM":3.2,"point":[0,0,0]}]}
{"event":"selection-changed","ids":["map-static:412:UtilityPole_3"]}
{"event":"overlay-state","id":"coverage","visible":true}
{"event":"resized","width":1600,"height":1000,"pixelRatio":1,"x":320,"y":180}
{"event":"frame-stats","source":"cpu-frame-delta","frames":57,"p50Ms":16.7,"p95Ms":18.2,"p99Ms":24.9,"residentBytes":898415932,"peakResidentBytes":898415932}
{"event":"device-lost","reason":"...","recoverable":true}
{"event":"error","code":"release_digest_mismatch","message":"..."}
```

Every event carries `mapVersionId`, `releaseDigest`, `renderer`, and
`canonicalDigest` once the manifest has been verified, so a host can correlate
a stream with the release it asked for. `frame-stats` is emitted once per
second only with `--frame-stats`.

`closed` is not in this list: the process cannot report its own exit. The host
wrapper (`studio/desktop/native-viewport.mjs`) synthesises
`{"event":"closed","code":N,"signal":S}` when the child exits, and the editor
adapter treats an exit it did not ask for as a renderer failure.

### Readiness states

`starting` → `manifest-ready` → `coarse-ready` → `interactive` → `complete`,
with `device-lost` and `error` reachable from any of them. Progress never runs
backwards; a recovered device restarts the sequence from `manifest-ready`
(identity is already proven) and re-announces each state as the scene comes
back.

Each state has a producer that can be false:

| state | evidence |
|---|---|
| `starting` | process is up and has no map yet |
| `manifest-ready` | `.map-release.json` parsed, schema/profile checked, requested digest equals the manifest's, every declared member present at its declared length, `master.gltf` content-hashed |
| `coarse-ready` | every node in the coarse plan is resident on the GPU |
| `interactive` | coarse tier resident **and** the render world reported no compiling pipeline and no unbound material for three consecutive frames |
| `complete` | nothing left to admit within the byte budget, no read in flight, GPU idle again, `geometry.bin` content-verified |
| `device-lost` | wgpu device-lost callback, or `debug-device-lost` |
| `error` | any rejection above, or a load failure |

"Assets loaded" is not "can be drawn": Bevy skips a draw whose pipeline is
still compiling and a mesh whose material has no bind group, so `interactive`
is gated on the render world's own counters rather than on asset load state.

### `PickResult.hits`

Hits carry the renderer-contract layers and are sorted nearest-first. `id` is
`<layer>:<glTF node index>:<node name>`, which is stable for a release because
the node index is a property of the immutable `master.gltf`. The native map
profile contains no actors, so the `actors` layer yields no hits from this
process; actor picking is answered by the editor's own actor layer.

The layer of a map node is geometric: a node whose bounds are under 1.5 m tall
and at least 8 m across is `ground`, everything else is `map-static`.

## Identity and verification

`load-map` is a request, not a fact. Before anything is loaded the viewport:

1. reads `.map-release.json` at the root and checks its schema
   (`simforge.map-installation.v1`) and `profile` (`native`);
2. checks that the requested `releaseDigest` is a lowercase SHA-256 and equals
   the manifest's;
3. checks that every member the manifest declares exists at its declared byte
   length;
4. content-hashes `master.gltf` before `manifest-ready`, because every later
   decision is read out of it.

`geometry.bin` is 60–400 MB across the canonical maps, so hashing it on the
startup path would cost a second of latency on every load. It is hashed on a
background thread instead, reported in `complete`'s `verified`, and a mismatch
fails the load with `member_digest_mismatch`.

## Progressive loading and the GPU byte budget

`master.gltf` is an index, not a unit of work: the canonical native profiles
are 0.6–8.7 GB, of which 0.6–8.5 GB is KTX2 texture payload. The viewport
therefore parses the document itself and admits nodes in tiers under an
explicit budget (`--gpu-budget-bytes`, default 2 GiB):

* **coarse** — positions and indices only, unlit. The coarse plan is the
  extent-ranked prefix of the scene that fits `--coarse-budget-fraction` of
  the budget (default 8%), so the first frame is decided by the large surfaces
  rather than by fence posts.
* **detail** — positions, normals, UVs and the authored material, with its
  base-colour KTX2 admitted only if the texture budget has room.

Between `coarse-ready` and `interactive` nothing new is admitted: the GPU has
to prove it can draw the coarse tier before the editor is told it can
interact, and a stream of fresh uploads would keep resetting that evidence.

Tier selection is screen-relative extent (world extent / distance to the eye):
at or above `--detail-screen-extent` a node is wanted at detail, below
`--coarse-screen-extent` it is evicted entirely. Eviction only ever removes
nodes less important than the node being admitted, which is what keeps the
scheduler from thrashing two nodes against each other.

`--stream-ops-per-frame` (default 4) bounds admissions and evictions per
frame. It is deliberately small: the failure mode of an unbounded upload queue
is a compositor-level GPU stall, not a slow load.

## Compositing: how native pixels reach the editor viewport

Bevy cannot draw into a DOM canvas, so the native backend has to put its
pixels inside a React layout some other way. Two options were considered:

**(a) A native OS window positioned and clipped over the React container
region, driven by `resize` — chosen.** The renderer keeps direct ownership of
its swapchain, so there is no per-frame copy and no second compositor in the
path, which is the entire reason the native backend exists. The React side
renders a transparent region, reports its rectangle in screen coordinates
(`packages/viewer/src/react.tsx`), and the window follows it on resize and
scroll. The costs are real and are borne here: z-order is managed by an
always-on-top window level rather than by the DOM, so a modal drawn over the
viewport region needs the native window hidden; DPI changes arrive as a
`pixelRatio` in `resize` rather than being inferred; and occlusion by other
application windows is the window manager's decision, not the page's.

**(b) An offscreen render target streamed into the renderer process.** This
composites cleanly with React — correct z-order, clipping and DPI for free —
but reintroduces a per-frame readback and copy of the full viewport, which is
precisely the cost the native path exists to avoid, and it doubles the frame's
peak memory. Kept as the fallback if (a)'s window management proves
untenable on a platform; it is not implemented.

## Fallback

`auto` starts this backend only when the executable and a complete native map
identity are available. Startup failure, device loss or protocol failure emits
`error` or `device-lost`; the editor then disposes the process and mounts the
existing WebGL adapter in the same region, without a page reload. Explicit
`native` reports the same failure to the editor instead of silently falling
back — a mode the user asked for by name must not quietly mean "whatever
worked".

## v2 (documented, not implemented)

```json
{"command":"gizmo","operation":"translate","space":"world","ids":["actor:1"],"delta":[1,0,0]}
```

`gizmo` needs manipulable entities. This process loads an immutable map
profile, whose nodes are not editable and whose actors do not exist here, so
there is nothing for a translate/rotate handle to move. Sending it yields
`{"event":"error","code":"command_not_implemented"}`, which tells a host
author the difference between "not in this protocol" and "not in this
version". The matching `gizmo-changed` event is not emitted by v1.
