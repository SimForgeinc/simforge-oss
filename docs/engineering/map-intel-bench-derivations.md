# Bench-map parking occlusion and road-surface derivations

The PoC supply update uses existing installed OpenDRIVE and GeoJSON only. It
adds derived evidence; it does not claim that missing school or bus-stop
annotations exist, and it does not replace the original `poc-v1` products.

## Parked-row occlusion potential

`packages/maps/src/intel/build/densify/parking-spaces.ts` accepts both source
representations: RoadRunner `ParkingSpace` polygons and OpenDRIVE
`parkingSpace` point objects carrying explicit length, width and absolute
local heading. The latter reconstruct their dimensioned rectangular footprint.
Missing dimensions are rejected; no default-sized bay is invented. When the
source omits an entry pose, entry heading remains unavailable rather than
being invented as zero. Previously the case-sensitive, polygon-only reader
dropped every parking object in the current semantic bench bundles.

`densify/occlusion-zones.ts` groups those footprints by nearest non-junction
driving lane and roadside. A bay must be outside the travelled lane's half
width plus 0.5 m, within 12 m of its centreline. Consecutive footprints may
have at most an 8 m longitudinal gap and a 3 m lateral change. A row needs at
least two bays and 8 m of longitudinal extent. These are *feature derivation*
limits, not changes to scenario admission or solver thresholds.

A zone is emitted only when an upstream lane-centre observer's finite sight
segment to a point behind the row intersects a source footprint, and a lateral
sight segment at the downstream row exit intersects none. The catalogue keeps
the source object IDs, road anchor, row interval, bay count, blocking/exit facts
and `occupancy_required: true`. Source IDs and the lane reference determine
stable location identity; source hashes plus the hashed
`parked-row-sightlines/v1` recipe determine catalogue revision.

This layer means **a mapped parking row can hide an occupied-roadside target**,
not that empty parking bays themselves block light. CPNCO supplies its actual
parked-SUV occluders. Each concrete seed must independently prove resolved
occluders, actual blocking, LOS opening before conflict and positive
reveal-to-conflict time, then complete native rehearsal and an admission-only
kernel Episode with zero contacts. A geographic feature is not a substitute
for those checks.

| Map | Source parking bays | Derived occlusion zones |
|---|---:|---:|
| Yale Street | 481 | 22 |
| El Camino Road | 967 | 18 |
| Belmont Research Center | 997 | 18 |
| Easterbrook Discovery School | 98 | 2 |

The current source bundles contain neither `school_zone` nor `bus_stop`
layers. A school in a map's name is not a school-zone annotation; these
optional families remain explicitly excluded rather than having prerequisites
removed.

## Source road-boundary outline

`packages/maps/src/topology/road-boundary.ts` builds
`road-boundary.json.gz` (`simforge.road-boundary/v1`, recipe
`opendrive-road-outline/v1`) in **OpenDRIVE-local metres**. It samples the
existing OpenDRIVE lane-width/cross-section implementation, includes driving,
bidirectional, ramp/entry/exit, parking, shoulder, stop and bicycle surfaces,
and excludes sidewalk, restricted, none and other non-road types. It dissolves
internal seams and overlaps into the complete source road outline using
millimetre integer inputs to polygon clipping. Interior rings remain island
exclusions; they are not filled to make trajectories pass.

Exposed lane-section caps are extent cuts, not kerbs. Collinear caps across
adjacent lanes are combined before removal; the resulting open boundary
chains mark both termini `CUT`. The finite dissolved source surfaces remain
as positive coverage, so a known road point cannot be misclassified by the
nearer open end of a different road. Outside finite source support, an open
cut remains unavailable instead of inventing a road ending or extrapolating
an unrelated boundary's traffic-side half-plane.

`loadBenchDrivableArea` prefers this source outline, validates its source
OpenDRIVE SHA-256 and (when installed) the installation member digest/size,
and schema-checks frame, coverage and all geometry. The footprint scorer
reports **`simforge.offroad/v3`**, source `opendrive-road-boundary`.
`authoritative` here means authoritative to the **simulated source road
cross-section**, not a surveyed real-world or rendered-mesh qualification.
The existing lane-only fallback remains low-confidence
`simforge.offroad/native-lane-polygons-v1` with unchanged interpretation.
An absent source outline does not silently upgrade that instrument.

The map pipeline emits the outline with road-sidecar revision
`source-semantics-v5`. For already installed bench maps, reproduce the local
augmentation with:

```sh
NODE_OPTIONS=--conditions=development pnpm exec tsx --tsconfig tsconfig.base.json \
  packages/maps/scripts-intel/derive-bench.mts \
  ~/.local/share/simforge/maps qualification/training-splits/poc-v2/maps \
  yale-street el-camino-road belmont-research-center easterbrook-discovery-school
```

Each of `dev-assets`, `map-bundles` and `.corpus` gets byte-identical derived
products and a `derived/supply-manifest.json`. `.map-release.json` updates its
member SHA-256/byte inventory and adds a separately digested `localDerivation`;
the published release/canonical digests remain the **upstream parent**, not a
false claim that modified bytes belong to an immutable published release.
Files are atomically replaced to break installed hardlinks without modifying
the content-addressed source blob cache. Frozen copies, source digests,
per-map manifests and the installed-loader smoke receipt are retained under
`qualification/training-splits/poc-v2/maps/`.

## Queue-tail correction

The original family put the required box-truck screen at `tFrac: 0`, in ego's
lane, but made it a noncollidable prop. A safe stop behind it could therefore
remain blocked forever; driving through the ghost screen was not a physically
valid resolution. Its fixed `0.4 * previewDistanceM` braking condition also
failed high-speed draws. El Camino had real seed-dependent contacts; Belmont's
safe stops failed the required reveal-before-conflict condition.

The revised queue remains a stopped two-vehicle queue, now revealed by a real,
collidable preceding delivery van pulling into a legal adjacent lane. It
requires two same-direction lanes, bounded curvature and legal left lane
change geometry. Queue vehicles remain on the continuous native route with
parallel headings, but need not share a single OpenDRIVE road-section label
with ego or one another. The first repair used a 120 m occupied-body envelope,
but that omitted the 6.3-second bench prologue. Its otherwise-safe queue stop
could award the native goal before the first policy action. Poc-v2 remains
immutable evidence of that defect, not a bench-qualified supply claim.

The witness caps approach speed at 40 km/h and begins braking after the reveal
interval using the source queue distance and a speed-dependent stopping
budget (6 m/s² deceleration plus bounded-jerk reserve). The intended final
bumper gap is 4.5–6.5 m. Per-seed native trace measurements, including gap and
reveal ranges, are recorded in `poc-v2/supply-survey.json`; failed native
lane-change/route candidates remain excluded with their actual reasons. This
is a scripted solvability witness, not evidence that the bench's cruising
`scripted` policy or a learned teacher succeeds.

The corrected family drives a **9.4-second approach** before cutting out.
Ego starts at station 50 m and the queue is moved downstream by
`9.4 * authored_speed_mps`; the 241 m minimum runway covers
`50 + 9.4*(40/3.6) + 65 + 11 + 10` metres (spawn, approach, preview, queue
spacing and clearance). The physical left-lane action is not mirrored.
Both native default goals and the actual bench `scriptedPolicy` continuation
must survive the 6.3 s prologue plus a 3 s reaction margin. Measured reveal and
lane-change onset must be at least 9.3 s; a requested but rejected lane change
does not count as onset.

Cut-in begins at 11 s, with its initial gap compensating for the two vehicles'
speed difference during the additional approach. CPNCO's conflict and parked
row move ten seconds of authored ego travel farther downstream without
reducing the approach speed. Each template retains its required geometric,
occlusion and zero-contact constraints; the new temporal condition is added,
not substituted for them.

New admission receipts use `simforge.scenario-admission/v2` and add the
`bench-window` check. Each seed records actual hazard events, a separate
native Episode with **default goals enabled**, and an Episode with 63 authored
prologue decisions followed by 30 actions from the real scripted bench policy.
Their native traces/digests accompany the existing whole-horizon scripted
solvability witness. Archived three-check manifests still verify their
historical contract; they are not silently upgraded to the new condition.
