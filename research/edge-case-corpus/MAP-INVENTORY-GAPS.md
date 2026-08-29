# Map-inventory gap list — hand-off for map authoring

Produced by `tools/gates/precheck_briefs.py` from **measured** `sites match --all-maps` counts over
all five dev maps, not from assumptions. This is deliverable 4 of the training-grade lane.

A structure is **absent** when the matcher binds zero sites for it, or cannot bind it at all. A brief
needing an absent structure cannot be authored on these maps in any form. A structure that exists but
cannot supply the frozen portability clause (**>= 2 maps AND >= 3 sites**) is listed separately: those
briefs can be authored but can never be *admitted* portably.

## 1. Structures the five maps cannot host at all

| structure | sites | maps | note |
|---|---:|---:|---|
| `driveway` | 0 | 0 | no site on any map |
| `kerbside_parking_residential` | 0 | 0 | no site on any map |
| `parking_aisle` | 0 | 0 | no site on any map |
| `rail_crossing` | 0 | 0 | matcher cannot bind this feature kind |
| `roundabout` | 0 | 0 | no site on any map |
| `school_zone` | 0 | 0 | no site on any map |
| `work_zone_suitable` | 0 | 0 | no site on any map |

## 2. Structures present but below the portability clause (>= 2 maps, >= 3 sites)

| structure | sites | maps | per-map |
|---|---:|---:|---|
| `bus_stop` | 2 | 2 | {"yale-street": 1, "richmond-field-station": 1} |
| `merge_or_diverge` | 2 | 2 | {"easterbrook-discovery-school": 1, "richmond-field-station": 1} |
| `crest` | 1 | 1 | {"el-camino-road": 1} |

## 3. Structures that ARE well supplied (for contrast)

| structure | sites | maps |
|---|---:|---:|
| `junction_any` | 294 | 5 |
| `plain_corridor` | 256 | 5 |
| `wide_lane_for_closure` | 223 | 5 |
| `oncoming_lane` | 206 | 5 |
| `parking_zone` | 95 | 4 |
| `junction_stop` | 72 | 4 |
| `multilane_junction` | 54 | 4 |
| `bike_lane` | 52 | 4 |
| `multilane_same_dir` | 51 | 4 |
| `occlusion_zone` | 28 | 4 |
| `junction_signalized` | 23 | 3 |
| `crossing` | 5 | 5 |

## 4. Ranked: taxonomy categories the maps cannot host, with the blocking structure

| rank | category | briefs | infeasible | share | blocking structure (measured site count) |
|---:|---|---:|---:|---:|---|
| 1 | **C8.workzone** | 14 | **14** | 1.00 | `work_zone_suitable` (0 sites / 0 maps) |
| 2 | **C12.school** | 12 | **12** | 1.00 | `school_zone` (0 sites / 0 maps) |
| 3 | **C4.roundabout** | 10 | **10** | 1.00 | `roundabout` (0 sites / 0 maps) |
| 4 | **C11.parking** | 13 | **5** | 0.38 | `parking_aisle` (0 sites / 0 maps), `driveway` (0 sites / 0 maps), `kerbside_parking_residential` (0 sites / 0 maps) |
| 5 | **C13.control** | 14 | **3** | 0.21 | `rail_crossing` (0 sites / 0 maps), `work_zone_suitable` (0 sites / 0 maps) |
| 6 | **C7.occlusion** | 14 | **2** | 0.14 | `school_zone` (0 sites / 0 maps), `driveway` (0 sites / 0 maps) |
| 7 | **C10.oncoming** | 13 | **1** | 0.08 | `kerbside_parking_residential` (0 sites / 0 maps) |
| 8 | **C5.pedestrian** | 16 | **1** | 0.06 | `school_zone` (0 sites / 0 maps) |

**48 of 208 briefs (23.1%) name a structure the five maps do not contain.**

## 5. What to author, in priority order

1. **`work_zone_suitable` corridors** — blocks all 14 C8.workzone briefs. Only `el-camino-road`
   declares the `workZones` capability at all, and no site binds.
2. **`school_zone`** — blocks all 12 C12.school briefs, and contributes to C5 and C7.
3. **`roundabout` junctions** — blocks all 10 C4.roundabout briefs. There is no roundabout on any
   of the five maps. Note that the anchor matcher has previously bound a roundabout archetype to
   non-roundabout sites and reported 24/24 `exact`; a real roundabout is needed, not a looser match.
4. **`parking_aisle` and `kerbside_parking_residential`** — a drivable aisle inside a parking area,
   and a narrow residential street with kerbside parking. Blocks 5 C11 briefs and is the exact
   finding of the earlier blind plausibility measurement (1/8, 1/8, 1/8).
5. **`driveway`** and **`rail_crossing`** — `rail_crossing` is in the schema but the anchor matcher
   cannot bind it, so this one is a *tooling* gap, not a map gap.
6. **`crest`** (1 site, 1 map), **`bus_stop`** (2 sites, 2 maps), **`merge_or_diverge`**
   (2 sites, 2 maps) — present, but below the portability clause. These need more instances rather
   than a new kind.
7. **`crossing`** at 5 sites across 5 maps and **`junction_signalized`** at 23 sites across 3 maps
   are the thinnest of the supplied structures; both are one bad draw from failing portability.

---

## 6. Speed-limit inventory (added after the deterministic authoring run)

Measured with `sites match --all-maps` on a corridor probe that varies only `speedLimitKph`:

| clause | sites | per map |
|---|---:|---|
| `speedLimitKph <= 30` | **0** | — |
| `speedLimitKph <= 40` | **0** | — |
| `speedLimitKph <= 50` | **0** | — |
| `speedLimitKph <= 60` | **0** | — |
| `speedLimitKph <= 70` | 29 | yale 6, belmont 6, el-camino 6, easterbrook 5, richmond 6 |
| `speedLimitKph >= 60` | 28 | yale 6, belmont 6, el-camino 6, easterbrook 4, richmond 6 |
| `speedLimitKph >= 70` | 1 | richmond 1 |

**The five maps publish no corridor posted at or below 60 kph.** Everything is 60–70.

Consequences already measured:

* the parking family authored at a residential speed (`speedLimitKph` in [25, 60]) produced
  **zero cells on every map**, which is what a 0/5 category looks like from the outside;
* it independently confirms the blind plausibility measurement's 1/8 scores for the parking
  archetypes — a child running out from between parked cars on a 65 kph road is implausible for a
  reason that has nothing to do with the harness;
* it interacts with the gate: a longitudinal conflict needs roughly 50 kph before the C2 and C4
  windows overlap at all, so these maps are *only* usable for high-speed longitudinal work.

**What to author:** residential and urban corridors posted at 30–50 kph. This is the same
dependency as the missing `kerbside_parking_residential` and `parking_aisle` structures in section 1
— those places are defined as much by their posted speed as by their lane markings.
