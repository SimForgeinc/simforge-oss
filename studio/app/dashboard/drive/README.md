# Drive

A real in-memory scenario editor whose compiled scenario can be driven
interactively on a map prepared on this computer. Drive reuses the scenario
editor's document, controller, actor library, inspector, header, and timeline
rather than maintaining parallel UI, and the same native live `WorldSession`
the rest of Studio simulates with; there is no second physics.

## Shape

```
page.tsx ─ requireAppContext, listLocalMapCatalog, then DriveClient
DriveClient.tsx ─ map choice, then the surface:
   DriveMapChooser       explicit catalog choice + LocalMapPreparationPanel
   DrivingControls       keyboard / wheel+pedals owner (input/), always mounted
   EditorHeader          shared authoring header and viewport settings
   ActorLibraryRail      controller-backed actor and environment placement
   EditorOverlayHost     selected-actor details
   ScenarioTimelineDock  authored actor lanes and world transport
   CityView              map and authored/live actor rendering
cameras/PoleCameraGrid.tsx ─ real feed beside a twin render, per pole camera
pole-cameras.ts ─ resolves rigs + map signal features
```

## Choosing a map

Drive never picks a map on its own. The page lists the same catalog as the
Maps app (`listLocalMapCatalog`: registered local maps plus what the current
SimCloud authorization publishes) with each map's local state, and mounts the
shared `LocalMapPreparationPanel` so a missing browser closure is downloaded
or a locked account map is connected right there. **Drive this map** resolves
the choice through `studioHost.artifacts.listMaps`, which is the server's
decision that the closure is installed and authorized; the map is remembered
as `?map=<mapVersionId>`. If a catalog refresh (SimCloud session change) no
longer allows the active map, the world is disposed and the chooser returns
with a notice.

`useEditorRuntime` opens a genuine blank `EditorDocument` in memory and binds an
`EditorController` to the viewer, lane index, and indexed ground sampler. The
local `AuthoredWorldSource` compiles that document through the normal playback
compiler and starts its `WorldSession` input in the live-world worker. Truth
frames drive the viewer imperatively; React does not re-render per simulation
tick.
## Running it

A live world needs a browser manifest and a lane topology. Both can be supplied
directly, so an un-ingested bundle is drivable without the authoring
publication pipeline:

```
/dashboard/drive
  ?manifest=/map-bundles/<name>/3d/manifest.json
  &lanes=/map-bundles/<name>/topology-index.json.gz
  &rigs=/drive-rigs/<name>.json     # optional pole cameras
  &twin=1                           # optional: attach to a twin on this host
```

With no `manifest`, Drive shows the map chooser. `?map=<mapVersionId>` opens a
prepared map directly through the same gate.
Env equivalents: `NEXT_PUBLIC_DRIVE_MAP_MANIFEST_URL`,
`NEXT_PUBLIC_DRIVE_MAP_LANES_URL`, `NEXT_PUBLIC_DRIVE_CAMERA_RIGS_URL`,
`NEXT_PUBLIC_DRIVE_TWIN_URL`. Camera feeds are proxied same-origin through
`SIMFORGE_TWIN_HTTP_ORIGIN`.

When exposing `next dev` through another hostname, include that hostname in the
comma-separated `SIMFORGE_ALLOWED_DEV_ORIGINS` server environment variable.

Direct bundles must have the same complete sidecar closure as published maps.
The `manifest` must end in `/3d/manifest.json`; `lanes` overrides the topology
used by the live world. Missing compiler sidecars or invalid digests are surfaced
as world-start errors rather than silently falling back to an ad-hoc simulation.

## Attaching to a live twin

With `?twin=`, two further surfaces are driven by the twin rather than invented
locally:

- **Site lighting** (`environment/`) — solar elevation and azimuth computed from
  the map's own geography (`CoordinateFrame` → WGS84, no configured coordinates)
  and the authoritative clock, applied through the shipped
  `applyEditorSceneEnvironment`.
- **Camera feeds** (`@/app/lib/live-world/camera-feeds`) — one WebSocket carries
  every channel, tagged per channel with its honest feed state. Construct it in
  an effect with cleanup because the class connects in its constructor.

### Historical replay

History is capability-driven; Studio does not contain a deployment-specific
archive URL. The `/twin` WebSocket advertises it in `twin_hello.replay`:

```json
{
  "retention_hours": 72,
  "archive_offset_seconds": 0,
  "archive_url_template": "https://twin.example/archive/get?path={channel}&start={start}&duration={duration}&format=mp4",
  "coverage_url": "https://twin.example/detections/coverage",
  "history_url": "https://twin.example/detections/history"
}
```

All three URLs may be `null`. The history dock is shown only when
`coverage_url` is non-null. Its UTC epoch clock comes exclusively from
`twin_mode` and `twin_clock`; both include `replay_speed` (`0` means paused)
and `tracks`. Studio sends `twin_replay { start, speed }` to seek, pause, or
resume, and `twin_live {}` to return to the live world.

When replay mode and `archive_url_template` are available, each camera replaces
the live mux canvas with a muted inline video. A clip is anchored where playback
starts: `{start}` is the detection clock at the seek, rounded down to a whole
second, plus `archive_offset_seconds` (default `0` for older servers), and
`{duration}` is `300`. Playback continues through the clip; a new clip is
requested when the clock leaves it, jumps (a seek), or the served clip ends
early because of a recording gap. Anchoring at the seek keeps a progressive
(non-seekable) MP4 aligned with the clock from its first frame; when the
browser can seek, drift beyond 0.5 seconds is corrected. A non-seekable clip
that starts more than 1.5 seconds behind the clock is re-requested once or
twice with its start led by the measured start-up latency (at most 15 seconds),
so the first frame of the new clip lands on the clock. The camera mux
remains connected in the background so returning to Live restores the canvases
immediately.

## Aiming a pole camera

A rig's numbers rarely match a real installation on the first try, so the
Cameras view can aim each channel by hand: compass heading, mount pitch, mount
height and the four extrinsic corrections, each editable as an exact number
because the target is a physical camera. The resolved scene yaw, vertical FOV
and final position are shown alongside, since the point is to debug an aim
rather than nudge a slider. A REAL-over-TWIN opacity overlay is the sharpest
tool here — coincident road edges and poles expose angular error that two
separate panes hide.

Adjustments live in `localStorage` per (pole, camera) and never mutate the
loaded rig. **Copy rig JSON** emits the complete payload to paste into product
configuration, which is the only durable home for calibration.

## Drive is camera and input ownership

**Free drive** designates the selected authored vehicle (or the best authored
runway) as ego, starts the document's compiled transport, attaches the camera
through `followCameraPose`, and hands the ego to `DrivingControls`. The native
world runs in live mode and is unbounded; while a free-driving ego owns it the
worker does not stop at the document's `clipSeconds`, so the operator can keep
driving around the map. **Drive clip** is the same ownership with the authored
boundary kept: the world parks at the clip end (`Clip ended · Drive again`).
Exiting sends neutral controls, releases the camera and ego ownership, and
stops transmitting while the authored scenario keeps playing; a free drive
that already passed the clip end parks as `Scenario complete` on exit.
Authoring chrome is hidden and the timeline is read-only only while that
ownership is active (and for the whole session of an editor take).

Camera: **Chase** and **Dash** follow the ego; **Free** returns the orbit
camera to the operator while controls stay live. **Restart** rebuilds the
world at t = 0 and keeps driving. A world error, a closed source or a map
that stops serving assets releases the ego immediately so controls go neutral.

`DrivingControls` (`input/`) owns keyboard and wheel/pedal selection,
calibration and the 50 ms control loop. It stays mounted for the life of the
page (device choice survives map changes) and transmits only with the active
ego's `actorId`; it neutralises and disengages on blur, hidden tab, actor or
source change, wheel disconnect, or a rejected command.

## Manual drive takes

The scenario editor opens `/dashboard/drive?manualDriveTake=<id>` for a
"Manual drive" interaction. The take session (owned by the editor's
`take-handoff` mailbox) carries the exact in-memory document, the map version,
the role to drive, an opaque `revision` guard and `onSave`/`onCancel`. Drive
loads that content read-only, binds the ego to the role (refusing if it is not
a controllable, non-static vehicle), and **Start take** asks the worker to
`begin-take`: rebuild the world at t = 0 and read the ego back from the native
truth stream, one sample per engine tick on the simulation clock, through the
clip end inclusive. Samples are `{ timeS, x, y, z, headingRad, speedMps }` in
the scene frame (`speedMps` is the truth velocity projected on the body heading, so reversing is negative from actual motion, never from input); the t = 0 sample
comes from the rebuilt world's snapshot because frames are published after
each tick. A dropped truth frame, a missing ego or an incomplete span fails the
take loudly instead of gapping it. Losing focus pauses the world (the clock is
the sim's, so nothing is lost) and **Resume take** continues it.

At the clip end the operator reviews: **Save take** calls `onSave(recording,
revision)` once — never if the document was recompiled since the take ran —
**Drive again** records a new take, **Discard** calls `onCancel`. Drive
persists nothing itself.

## Cameras on poles

A rig binds camera channels to a `SignalFeature` id — a traffic-light pole in
the map — and each channel carries its own compass bearing, pitch, mount height
and intrinsics. Pose comes from surveyed map geometry via `resolveCameraPose`
(`@simforge/maps/camera-rig`), not per-site constants. Vertical FOV is derived
from `fy` and image height.

`headingDeg` is a **compass** bearing; `resolveCameraPose` applies the −90 that
converts it to scene yaw, which is why it uses `(cos yaw, sin yaw)` and does not
repeat the local→scene `-sin` from `renderer-contract.ts`.

A pole's `zOffset` is its signal head, **not** the camera height: at Richmond the
head sits at 4.48 m while the rig is at 7 m on the same mast.

Rigs are supplied at runtime and carry the stream URLs. Map bundles are
content-addressed and must never contain endpoints or credentials.

Only the focused channel streams. Long-lived `multipart/x-mixed-replace`
responses each consume one of the browser's six connections per host, and four
of them starve map-tile streaming. Non-focused channels show an explicit paused
state — never a stale frame presented as current.
