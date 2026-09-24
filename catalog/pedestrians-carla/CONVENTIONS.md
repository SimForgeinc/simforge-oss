# SimForge CARLA pedestrian models — conventions

38 self-contained, skinned GLBs converted from CARLA 0.10.0 UE5 content.
`manifest.json` records source meshes, hashes, sizes, clip sources and per-material
colour provenance. `ATTRIBUTION.json` covers all 38 unique ids/files, including
animations; none is missing attribution.

## Coordinate frame and binding

- Raw GLBs: right-handed, **Y-up, meters**.
- **Bind-pose facing: +Z.** Front views of G2 and G3 T-poses establish this
  independently of motion.
- **Walk gait axis: +Z.** Measured stance feet move backward along -Z while
  the root stays stationary. Run uses the same skeletal forward convention.
- SimForge actor forward is **+X**. Apply **+pi/2 about +Y** on the model binding,
  not the trajectory: browser `yawRad`, native sidecar `yawOffsetRad`. The browser
  catalog swaps raw X/Z extents when expressing the rotated length/width.
- Earlier GLBs falsely claimed `+X forward` in `asset.extras.convention`.
  The embedded string, external manifest and generation tools now separately
  state bind-pose facing and gait axis. No rotation was baked into geometry or
  motion; the binding owns the correction.

## Rig families and clips

| Family | Models | Skin joints | Channels per clip |
|---|---|---:|---:|
| G2 | 0015–0050 (36 files) | 66 | 65 rotations + 1 hips translation |
| G3 | 0051–0052 (2 files) | 26 | 25 rotations + 1 hips translation |

Every file includes named `walk`, `idle`, and `run` clips. Durations are per-model,
not global constants: 0015 walk/idle/run last 2.366667/19.666666/2.266667 seconds;
0051 lasts 2.033333/26.333334/0.733333 seconds. The browser selects `walk` above
0.1 m/s and `idle` otherwise; existence of `run` does not imply speed-based run
selection.

Bone hierarchy, inverse bind matrices, target bone lengths and mesh payloads are
preserved. G2 import omits two source-only eye leaves absent from the target skin;
G3 maps its 26 joints directly. The root is `crl_root`; translation targets
`crl_hips__C`. Raw `node[0].name` is `<SourceMesh>.ao`, matching the manifest.

## Root motion: in place

The simulator owns world translation. Clips animate hips sway/bob and limb
rotations, not accumulated displacement. All **114 clips** have exactly one
translation channel, on `crl_hips__C`, and no animated root translation. Maximum
absolute hips loop-endpoint discrepancy across all axes/clips/models is
**0.000505 m**: a sub-millimetre loop discontinuity, not cumulative motion.
143 browser samples each for 0015 and 0051 measured an exactly stationary root;
a sample at 23.7 s also remains actor-bound. Never integrate hips translation
into actor position.

## Grounding: measured per clip, never assumed

A walker's model origin is not its sole. Renderers put the origin on the
simulator's ground point, so each clip carries the lift that stands its posed
soles on the ground, measured at ingest by `tools/ground.py` (run after
`animate.py`, before `finalize.py`):

- every keyframe and midpoint of each clip is posed exactly as glTF defines it
  (node TRS, slerped rotations, 4-influence linear blend skinning) and its
  lowest vertex taken;
- `soleHeightM[clip]` (in `assembly-stats.json` and `manifest.json`) is the
  **stance sole height**, the median of those lows; `soleRangeM[clip]` is
  their [lowest, highest]. A constant lift cannot hold every pose at zero: in
  one walk cycle the lows span 3-7 cm (hips bob; heel strike dips a few frames
  below the stance, worst 5.7 cm on the G3 walk). Lifting by the single lowest
  pose would float the walker for the rest of the cycle;
- `finalize.py` writes `groundOffsetM` (bind pose) and
  `model.clipGroundOffsetM.{idle,locomotion}` into `catalog-models.json`, and
  refuses a model without a measurement. The native closure carries them as
  `animations.<motion>.groundOffsetM`, the browser binding as
  `groundOffsets`. Both renderers refuse or ignore nothing: the native service
  fails a walker clip with no measured lift.

Measured stance heights below the origin: G2 adults 2.2-6.1 cm idle and
-0.3-3.6 cm walking, G3 0.9 cm idle and 0.0-0.1 cm walking, and the **G2
children 0049/0050 27.4-27.6 cm idle and 26.6-26.7 cm walking**. The child figure is an `animate.py` retarget defect: the `AS_Girl_*`
clips are authored on the child mesh (hips ~0.6 m), but the hips translation
is retargeted against `Skel_Pedestrian_G2`'s shared adult reference pose
(hips 1.05 m), so `target + (sample - reference) * ratio` lowers the child's
hips by ~26 cm while the leg rotations stay intact. The pose is therefore
unchanged apart from a vertical offset, which the measured lift removes
exactly; the GLB bytes are left as shipped. (A future re-animation should
retarget child clips against the child rest pose; `ground.py` must then be
rerun.)

## Browser proof and known cadence limitation

Real Chrome WebGL proof used the production viewer `ActorRenderer`, production
external GLB loader, generated bindings and actual `studio/public` model URLs.
Response SHA-256 and raw node-zero identities verified 0015/G2 and 0051/G3, avoiding
any deterministic native walker substitution. Captures at 0, 0.3, 0.6, 0.9, 1.2
and 1.8 seconds show changing arm/leg poses. Both rigs face and stride along actor
+X after binding correction. No collapsed/exploded mesh, wrong-axis joint motion
or inverted knees was observed on these representatives; this is not a visual
certification of all 38.

**Known fidelity defect, deliberately not fixed here:** browser playback calls
`setTime(animationTimeS)` without speed-dependent cadence scaling. At an actor
speed of **1.2 m/s**, corrected G2 stance feet slip backward approximately
**0.19–0.21 m/s**, and G3 **0.66–0.76 m/s** (over three times as much). Measurements
use foot-bone world-space finite differences at 60 Hz and the lowest 40% of foot
heights as a stance approximation, not a contact solver. Natural stance speed
is about 1.4 m/s for this G2 walk and 1.9 m/s for this G3 walk. G3's mismatch is
already substantial at 1.2 m/s; at 2 m/s G2 has about 0.6 m/s forward slip.
There is no universal perceptual threshold: camera distance and terrain matter.
Translating-actor captures exercise 1.2 and 2 m/s. A future fix needs per-clip
calibration, not one global multiplier. This is separate from the corrected
sideways-gait bug and from root-motion drift.

## Material defect and bounded mitigation

Browser proof uncovered **105 normal-as-base-colour slots across all 38 files**,
representing 57 unique material instances. Example 0015 pants/jacket originally
used `baseColorTexture.index = 0`, image `T_Plastic_02_n@d1024`, median RGB
**(128,128,254)**. Pants' actual normal was a distinct image at index 1. Its face
correctly used `T_AfroF01_Head_d@d1024`, median **(151,86,43)**. 0051 clothes used
`T_Fabric03_n@d1024` as albedo. This is a per-material source-extraction defect,
not a global lighting/colour-space problem or viewer mis-binding. The assembled
files contain no correct apparel diffuse replacement for these example slots.

The vehicle ambulance reference instead has genuine `T_Ambulance_Details03_d`
albedo, a separate normal, and intentionally shared ORM for occlusion and
metallic/roughness. The pedestrian assembler reuses vehicle material helpers but
its clothing material selection exposed normal images as diffuse; these are
not interchangeable source material conventions.

`tools/repair_materials.py` removes the proven false references, leaving normal
and ORM bindings intact and **preserving the complete binary GLB payload**.
`tools/assemble.py` applies the same policy during future assembly. No substitute
texture is synthesized. Unreferenced old images remain in the binary payload.

Authoritative material-instance `.uasset` and `.uexp` records were recovered
from local Docker image `simforge/carla-render-worker:native-migration-abi2`,
under `/home/carla/CarlaUnreal/Content/Carla/Static/Pedestrian`, and decoded with
CUE4Parse. **49/57 instances (84/105 slots)** have primary `Color_1` vector
parameters; these are used as flat `baseColorFactor` RGB. **UE FLinearColor is
linear RGB, as is glTF baseColorFactor: no sRGB conversion was performed.**
The existing glTF alpha is retained (1.0 on these slots), not UE colour-parameter
alpha, which is often zero and is not garment opacity.

The remaining **8 instances (21 slots)** lack a primary `Color_1` override and use
explicit neutral-gray `[0.5,0.5,0.5,1]` placeholders. `material-tints.json` lists
all 57 sources/parameters/values and individually flags placeholders; each model's
`manifest.pedestrians[id].materialColorFallbacks` and GLB material extras identify
the affected slots. `B_Color_*` and `C_color` were deliberately not applied as
whole-material colours: they belong to masked secondary layers.

This is an honest mitigation, **not full CARLA material fidelity**. Flat primary
tints cannot reproduce original layered masks, wear, fabric microdetail or
spatial colour variation. Source extraction/material reconstruction remains
necessary for exact apparel appearance. Native scenario evidence available to
this audit contained only ambulances, so native pedestrian colour was **not
visually verified**; asset binding correctness was established independently.

## Attribution and conversion

Models and animations © Computer Vision Center (CVC), Universitat Autònoma de
Barcelona (UAB), and CARLA Simulator contributors: <https://carla.org/>.
**Creative Commons Attribution 4.0 International**:
<https://creativecommons.org/licenses/by/4.0/>. Retain attribution and modification
notices on redistribution. Conversion includes Unreal skeletal export,
self-contained glTF packaging, embedded/PBR-normalized textures, native in-place
motion and the documented material mitigation. All 38 attribution records include
the modifications.

## Streaming size consequence

Animation commit `e2c7dc38`, compared with its parent:

| Payload | Before animation | Animated | Animation increase |
|---|---:|---:|---:|
| 38 GLBs | 649,379,924 B (619.297 MiB) | 678,461,252 B (647.031 MiB) | 29,081,328 B (27.734 MiB), **4.478%** |
| 0015 | 17,880,708 B | 18,699,244 B | 818,536 B |
| 0051 | 13,057,140 B | 13,440,024 B | 382,884 B |

Subsequent material/convention metadata repair adds **33,396 bytes** of JSON:
the final pack is **678,494,648 bytes** (647.063 MiB). Current per-model exact
byte counts are in `manifest.json`. Mesh, texture and animation
binary bytes did not change. Animation bytes are embedded, so a model request
streams its clips too. This is real but modest overhead relative to the existing
mesh/texture pack; showing one actor does not require downloading all 38.
All 38 served `studio/public/catalog/pedestrians-carla/models` copies are updated
together and SHA-256 checked against canonical files after repair.
