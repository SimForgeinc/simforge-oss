# Driver in the loop

One entry point, one artifact, no new data structures.

From a scenario row in the dataset list, beside Edit: **Driver in the Loop**. Pressing it

1. creates a **variation** of that scenario — a separate document with a parent pointer, the same
   map, the same dataset — with a sensor rig guaranteed on the actor about to be driven,
2. opens the drive UX on that actor,
3. records its trajectory for exactly the scenario's clip length, and
4. writes that trajectory into the variation as the actor's motion, then returns to the list.

The variation is then an ordinary scenario: it carries the existing `Variation` badge, opens in the
editor, plays back, and renders.

## Why this needs nothing new

- **The clip is an existing interaction.** `packages/scenario/src/schema/v2/manual-drive.ts:55-76`
  defines `ManualDriveRecording` (`{ version, clipSeconds, samples[{ timeS, x, y, z, headingRad,
  speedMps }] }`) and `:100-151` validates it: strictly increasing time, a sample at exactly `0` and
  at exactly `clipSeconds`, `y === 0`, 2..6001 samples.
  `packages/editor/src/manual-drive.ts` turns a recording into the actor's motion
  (`recordedManualDrive`), and `EditorDocument.replaceActorMotion` displaces whatever motion the
  actor had.
- **Playback and render already replay it.**
  `native/crates/simforge-compiler/src/materialize/builder.rs:770,1648-1754` folds the interaction
  into the actor's spawn as a `recordedTrack`; `native/crates/simforge-core/src/map/timed.rs:17-21`
  interpolates recorded pose, yaw and signed speed between samples. A 20 Hz capture replays on the
  50 Hz engine tick.
- **Lineage already exists.** `derivation_kind = 'variation'` with `derived_from_document_id` already
  satisfies the CHECK in `studio/migrations/20260805013000_uniscenario_document_lineage.sql:95-100`,
  and `ScenarioDocumentRow` already badges a variation. No migration.

## How it works

### Creating the variation

- `POST /api/simforge/documents/[documentId]/driver-in-the-loop` — same two access checks as
  `duplicate` (source copyable, destination mutable). Body: `{ roleId? }`. Responds
  `{ document, roleId }`, or `409 not_drivable` with a readable reason.
- `studio/app/lib/scenario/driver-in-the-loop.ts` decides the two things that must be decided before
  the variation exists:
  - `resolveDriverRole` — the requested role, else the scenario's `metricSubject`, else its only
    drivable vehicle. Refuses an unpinned scenario (a scene-frame recording cannot replay without a
    pin), a non-vehicle or frame-bound role, and an ambiguous scenario, so a refusal is a message on
    the button rather than a dead drive screen.
  - `driverInTheLoopContent` — attaches the `basic-dash-camera` rig
    (`instantiateSensorRig`) when the driven actor has no sensors, because the list disables render
    without a sensor profile. An actor that already has sensors is untouched.
- `duplicateScenarioDocument` takes `derivation` and `content`, so the variation is written with its
  own digest in the same transaction as its parent edge.

### Starting the drive

- `ScenarioDocumentRow` renders the Driver in the Loop button beside Edit
  (`onDriverInTheLoop`); it is inert with an explanatory tooltip on a read-only dataset and absent
  where no handler is supplied (the review queue).
- `useScenarioDocumentActions.startDriverInTheLoop` POSTs, splices the variation into the list — the
  drive leaves the page, and coming back to a list that had forgotten the variation would read as a
  lost drive — and returns the drive target.
- `ScenarioDatasetsClient` owns the navigation to `/dashboard/drive/<documentId>?actor=<roleId>`; the
  dataset column never routes on its own, because it keeps the world scene beside it alive.

### Driving and saving

- `studio/app/dashboard/drive/[documentId]/page.tsx` loads the document, resolves the actor, and
  renders `DriverInTheLoopDrive`, which resolves the installed map entry and its lane topology.
- `DriveSession` is take-only: it compiles the variation once, drives the resolved actor from
  t = 0 (`beginTake`), and shows the clip countdown from the world clock. The scenario's other
  actors run around the driver. `R` drives the clip again.
- On `TakeEvent { kind: 'complete' }` the session applies `recordedManualDrive` to its live
  `EditorDocument` and hands the finished template to `onSaveClip`, which PATCHes the variation and
  returns to the list. A failed take or a rejected save keeps the drive on screen with the reason and
  a "Drive it again" action; nothing partial is written.

## What was removed

Driving used to start from the map gallery, and takes used to be authored from the editor timeline
and round-tripped through a `localStorage` mailbox. All of it is gone:

- `packages/studio-ui/src/scenario/editor/manual-drive/` — the take mailbox (`take-handoff`), the
  editor recorder hook, and the details/review panels. `competingMotionRefusal` survives as
  `packages/studio-ui/src/scenario/editor/competing-motion.ts`.
- The take-guard machinery in `packages/editor/src/manual-drive.ts`
  (`manualDriveTakeGuard`, `encode`/`decodeManualDriveTakeGuard`, `checkManualDriveTake`). It existed
  because a take round-tripped through another tab against a document the author could edit
  meanwhile; a variation is created for one drive and nobody else is editing it.
- The `manual_drive` timeline palette action, so a recording can only come from a drive.
- Free drive: `drive-scenario.ts` (`createDriveScenario`, `pickDriveSpawn`), `MapGalleryDrive`, the
  gallery's Drive button and its take-query handling, the car/map pickers, the spawn selector, and
  the `endless` world-source mode. `drivingLanes` survives as
  `studio/app/dashboard/map-assets/drive/drive-lanes.ts` for the HUD's minimap.
- The pause menu's Respawn and Change car, which only meant anything without a scenario.

## Verification

- `studio/app/lib/scenario/__tests__/driver-in-the-loop.test.ts` — role resolution (only vehicle,
  declared subject, explicit request, ambiguity, pedestrian, missing actor) and variation content
  (rig added, existing rig kept, nothing else changed).
- `packages/studio-ui/test/unit/scenario/list-document-row.test.tsx` — the button calls its handler,
  is inert on a read-only dataset, and is absent without a handler.
- `packages/editor/src/manual-drive.test.ts` — a recorded track still follows its actor when the
  actor is moved.
- Typecheck: `packages/editor`, `packages/studio-ui` and `studio` are clean apart from a pre-existing
  `app/lib/dashboard-nav.ts` error (an `icon`-less nav entry) that predates this work.
