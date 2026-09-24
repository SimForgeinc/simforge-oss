# Street luminaires (`derived/luminaires`)

At night the native renderer lights the scene with the map's street
luminaires. The service takes them as `lighting.night.fixtures` and lights the
nearest ones as a bounded pool of point lights (`STREET_LUMINAIRE_ACTIVE_LIMIT`,
12, at the calibrated photometry: 4,000 lm, 2,700 K). Until this derivative
existed, the platform path handed it none, so every night render had dark
lamp heads and no light pools.

## The derivative

`@simforge-oss/map-pipeline` `buildLuminaires` writes
`derived/luminaires/manifest.json` (schema `simforge.map-luminaires.v1`). It
is a pure function of `master.gltf`: node names, transforms, and the POSITION
accessor bounds.

A **fixture** is a node that meets all of these:

- Its name carries a street-light token: `StreetLight`, `street lamp`,
  `lamp post`, `light pole`, `road light` or `luminaire`. Camel-case, `_ .-`
  and braces all count as word boundaries. RoadRunner names fixtures
  `{<guid>}StreetLight_30ft`.
- No ancestor is already a fixture.
- Its subtree's world box is 2 to 20 m tall and at most 12 m across.

The **bulb position** is chosen in this order:

1. The centre of a named lamp-head descendant (`Luminaire_Head01`). Rule
   `head`.
2. Otherwise, 0.25 m under the top of the fixture box. Rule `top`.

A **lamp head exported on its own** also counts, when it is not inside a
fixture and is at most 3 m across. Examples are RoadRunner's parking-lot heads
`{<guid>}Luminaire_Head02` and Belmont's heads. Its bulb is the head's centre.
Rule `lamp-head`.

Positions are in the master's glTF frame (metres, y up), which is the render
scene frame. A master without street lights still gets a manifest with an
empty list, so a night render can tell "none on this map" from "never
derived".

Local maps, builder revision 1:

| Map | Fixtures (head / lamp-head) |
|---|---|
| Easterbrook | 16 (16 / 0) |
| Belmont | 71 (0 / 71) |
| Richmond | 13 (1 / 12) |
| San Ramon P1 | 228 (29 / 199) |
| San Ramon P2 | 208 (45 / 163) |
| San Ramon phase 2 | 79 (1 / 78) |
| Yale | 49 (32 / 17) |
| El Camino | 39 (36 / 3) |
| Di Rosa | 146 (0 / 146) |
| Garching | 77 (0 / 77) |

**New maps:** the master stage builds the derivative. Its builder fingerprint
is part of the stage key.

**Published versions:** it is backfilled as a derivative set, with no new map
version:

```
reconcile-map-derivatives.ts --derivative luminaires
```

The descriptor key is `luminaires`.

## The render

The worker downloads the manifest with the job's inputs. It hands the
fixtures to the service ordered nearest-first to the job's camera path (the
closest approach of any scheduled camera eye). The service lights the first
`fixture_budget` of that list until it has a camera pose. After that it
re-sorts by distance to the camera on each relight. The first camera eye is
passed as `night.observer_position`.

The service turns luminaires on when the sun is at or below −3°
(`NIGHT_SOURCES_ELEVATION_DEG`).

**Evidence:** the manifest's `luminaires` field is gated by
`native-evidence.luminaires` and records:

- the manifest digest;
- the build key;
- the fixture count;
- `lit`, which is true when the sun was low enough to light the fixtures.

It is `null` when the map carries no derivative. A night render of such a map
warns `night_luminaires_absent`.
