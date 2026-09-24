# Map road decals (`derived/road-decals`)

RoadRunner exports road wear as alpha-blended decal layers over the road
surface: materials named `<Asset>_<Group>_<Surface>_Layer<N>` with `N >= 1`
and `alphaMode: BLEND`. For example, `OilPath01_Road_Roads_Road_Layer1` is a
banded oil texture (alpha up to 0.6) stretched along each lane by its
`KHR_texture_transform`.

The native renderer composited these layers at their authored opacity as
plain albedo, so every lane showed a dark streak down its centre. On the
location-matched comparison, CARLA (Unreal) renders the same layers almost
invisibly.

## The derivative

`derived/road-decals/manifest.json`, schema `simforge.map-road-decals.v1`,
is built by `@simforge-oss/map-pipeline` `buildRoadDecals`. It contains:
- the master it was built from (`source.master.sha256`);
- the wear-decal materials (index, name, family, layer);
- the blended layers it leaves alone;
- one `opacityScale`.

Wear families are `OilPath`, `OilStains`, `LinearCracks` and `Cracks`. Other
blended layers are content, not wear, and keep their authored opacity: lane
paint (`LaneMarking*`), symbols (`handicapped_png`), utilities and tram rails.

The derivative is a pure function of `master.gltf`, so the master does not
change and neither does the map version:
- **New maps:** the master pipeline builds it into the native closure.
- **Published map versions:** it is backfilled as a derivative set
  (`reconcile-map-derivatives.ts --derivative road-decals`, descriptor key
  `roadDecals`).

The platform stages it with the closure, and the service multiplies each
listed material's base-colour alpha by `opacityScale` when the scene loads
(`render-core` `road_decals`). A listed material that is not alpha-blended
fails the job (`native_road_decal_not_blended`). A derivative built from
another master also fails the job (`native_road_decals_master_mismatch`).

Run evidence records what was applied: the manifest's `roadDecals` field
(digest, build key, scale, material count), gated by
`native-evidence.road-decals`. It is `null` when the map carries no
derivative.

## Calibration (revision 1: `opacityScale` 0.2)

Fitted on the five Easterbrook locations of the CEO comparison, rendered at
1920×1080 with a 105° FOV and the showcase preset (Easterbrook is the only
comparison map with wear decals).

For each location, SimForge was rendered at scales 1, 0.6, 0.4, 0.25, 0.1 and
0. The decal pixels are the pixels that scale 1 darkens by more than 15%
against scale 0 (bottom half of the frame, hood excluded). The measured
quantity is the median luminance of those pixels over the median of a ring of
road around them, normalised by the same ratio at scale 0 (1.0 means the
decal is invisible).

| | darkening at the decal pixels |
|---|---|
| CARLA Epic (same pixels) | 1.000 ± 0.032 (locations 2, 3 and 5) |
| SimForge, authored opacity (1.0) | 0.877 |
| SimForge 0.6 / 0.4 / 0.25 | 0.922 / 0.941 / 0.966 |
| SimForge **0.2** (chosen) | ~0.972 |
| SimForge 0.1 / 0 | 0.977 / 1.000 |

Location 4 is excluded because tree shadows dominate the ring in both
engines. 0.2 is the largest scale within one standard deviation of CARLA: the
wear stays faintly visible, as it is on real roads, instead of reading as
streaks. Changing the scale or the families bumps `ROAD_DECALS_REVISION`.
