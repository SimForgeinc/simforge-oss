# Authored driving-policy runs

Studio's drive routes are **bench launchers and recorded-run viewers**, not
human-in-the-loop simulators (cutover: 2026-09-22). The kernel `Episode` is the
only closed-loop authority. See [the local/host boundary](local-cloud-boundary.md)
and [the drive bench contract](drive-bench.md).

## Scenario entry

`/dashboard/drive/<documentId>?actor=<roleId>` resolves the existing authored
document and selected vehicle role. `DriverInTheLoopDrive` resolves its installed
map; `DriveSession` uses the existing authoring compiler with
`materializeOnly: true`, sets the compiled actor as `metricSubject`, and submits
the resulting input to the local bench job API. It never starts a world,
advances a tick, sends pedals/steering, records a take, or saves policy output
back into the document.

The editor/list's existing variation-creation and role-resolution operations
remain authoring features: the scenario shown in the launcher is that resulting
document, including its authored content. This cutover does not change editor
motion tools, manual-track schemas, sensor authoring, or existing saved tracks.
The earlier automatic human-drive recording/save behavior has been removed.

## Map and path entry

`/dashboard/map-assets/drive` accepts an instance or `episodes.json` path. A map
selection prepares a one-car scratch scenario from its lane index. The gallery
may use its existing authoring camera once to choose a spawn; the standalone
launcher creates no WebGL viewport. Neither runs an environment in the browser.

The launch form supplies policy, seed and policy duration. **Run with policy jev**
submits a new bench job, not a takeover of a browser world. The bench launches
the normal policy server, handles its native prologue, and writes the same
artifacts as the CLI. Studio streams worker output plus `log.txt`, waits for
`drive verify`, then opens `/dashboard/evaluation/viewer?ref=<run-directory>`.

## Recorded playback

The viewer plays `drive.mp4` or `heat.mp4` and reads `steps.jsonl`, `score.json`,
`result.json`, model-health receipts and optional recorded model BEV. Solo
videos include the camera prologue; heat videos begin at policy time zero.
The viewer accounts for that offset and never displays a policy decision over
a prologue frame. A failed health receipt stays exploratory, even if the run
status is `succeeded`.

`studio/app/lib/live-world/`, its act/human worker, the Jev browser controller,
drive-only SUMO bridge, truth-frame HUD helpers and the old drive-activity smoke
have been deleted. Editor preview/playback remains in the existing shared
editor/playback packages; no part of the removed live-world subsystem is kept
for it. The targeted timeline regression and real no-WebGL Playwright proof
are documented in the local/host boundary document.
