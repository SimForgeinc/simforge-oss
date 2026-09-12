# simforge-core public API (NativeFoundation)

Crate `simforge-core`, lib `simforge_core`. Workspace `native/Cargo.toml` (`members = ["crates/*"]`, `[workspace.dependencies]`: serde, serde_json, thiserror = "2", sha2 = "0.10", flate2 rust_backend). Edition 2021, rust-version 1.85, all math `f64`.

## `simforge_core::error`
- `SchemaIssue { code: &'static str, path: String, message: String }` (zod codes: invalid_type/too_small/too_big/not_finite/invalid_string/invalid_enum_value/invalid_literal/invalid_union_discriminator/unrecognized_keys/custom).
- `SchemaError { issues: Vec<SchemaIssue> }` (Error + Display).
- `SimIssueCode` enum (snake_case serde; `as_str()`): RouteLaneMissing, RouteDisconnected, RouteEmpty, RouteOrientationAmbiguous, RouteTurnUnavailable, RunwayInsufficient, DecelBudgetExceeded, TimedRouteSpeedUnreachable, TimedRouteAccelerationUnreachable, TimedRouteTurnUnreachable, SpawnOverlap, SpawnOffLane, SpawnLaneNotOnRoute, SpawnLanePoseMismatch, TrafficControlRouteUnbound, TrafficControlBindingRepaired, ReverseSpawnHeadingAdjusted, ActorUnknown, InteractionUnknown, SignalUnknown, ArrivalUnsolvable, LaneChangeIllegal, LateralDurationClamped, LateralTrackingFailed.
- `SimIssueSeverity { Error, Warning }`.
- `SimIssue { code, severity, path: String, reason: String, detail: Option<serde_json::Map<String, Value>> }`; ctors `SimIssue::error(code, path, reason)`, `SimIssue::warning(..)`, `.with_detail(map)`, `.is_error()`.
- `SimEngineError { message: String, issues: Vec<SimIssue> }`, `SimEngineError::new(message, issues)`.
- `CoreError` (thiserror): `Json(serde_json::Error)`, `Schema(SchemaError)`, `Topology(String)`, `Canonical(String)`, `Engine(SimEngineError)`; `From` impls for serde_json::Error, SchemaError, SimEngineError.
- `simforge_core::Result<T> = std::result::Result<T, CoreError>` (re-exported at crate root).

## `simforge_core::math` (xodr-local frame: x east, y north, heading CCW from +x)
- `Vec2 { x: f64, y: f64 }` Copy/Default/Serialize/Deserialize; `ZERO`, `new`, `from_heading`, `dot`, `cross`, `length`, `length2`, `heading`, `rotated`, `perp_left`, `is_finite`; ops `+ - * f64, neg, += -=`.
- `SceneXZ { x, z }`; `local_from_scene(SceneXZ) -> Vec2`; `to_scene_xz(Vec2) -> SceneXZ`; `scene_heading(f64) -> f64`.
- `TWO_PI`, `clamp`, `lerp`, `dist`, `dist2`, `normalize_angle`, `angle_delta`, `lerp_angle`, `js_round` (ECMAScript Math.round), `quantize(v, decimals: i32)`.
- `Obb { center: Vec2, length_m, width_m, heading_rad }` Copy/serde camelCase; `obb_corners(&Obb) -> [Vec2; 4]`, `obb_overlap(&Obb, &Obb) -> bool`, `obb_separation(&Obb, &Obb) -> f64`.
- `SegmentProjection { t, d2, closest: Vec2 }`; `point_segment(p, a, b) -> SegmentProjection`; `segment_intersection(p, p2, q, q2) -> Option<f64>`; `point_in_polygon(p, &[Vec2]) -> bool`; `distance_to_segment(p, a, b) -> f64`.

## `simforge_core::rng`
- `Seed { Number(f64), Text(String) }` (Serialize as int/string, Deserialize; From<f64/i64/u32/&str/String>; `to_u32()`).
- `seed_from_string(&str) -> u32` (FNV-1a over UTF-16), `normalize_seed(&Seed) -> u32` (ToUint32(abs(trunc))).
- `Rng` xoshiro128** (Clone/Eq/serde): `Rng::new(&Seed)`, `Rng::from_u32(u32)`, `Rng::from_label(&str)`, `next_u32()`, `next_f64()` [0,1), `range(lo, hi)`, `fork(&str) -> Rng` (keyed on current s0), `state() -> [u32; 4]`, `Rng::from_state([u32; 4])`.

## `simforge_core::hash`
- `sha256_bytes(&[u8]) -> String`, `sha256(&str) -> String` (lowercase hex).
- `cmp_utf16(&str, &str) -> Ordering` (JS string order).
- `js_number_to_string(f64) -> String` (ECMAScript Number::toString).
- `canonical_json(&Value) -> Result<String, CoreError>`, `canonical_json_of<T: Serialize>(&T)`, `content_hash(&Value) -> Result<String, CoreError>`, `content_hash_of<T: Serialize>(&T) -> Result<String, CoreError>`.

## `simforge_core::types` (scene frame {x,z} as authored; serde camelCase; Option fields omitted when None)
Entry points: `parse_scenario_input(&str) -> Result<SimScenarioInput, CoreError>`, `parse_scenario_input_bytes(&[u8])`, `parse_scenario_input_value(&Value) -> Result<SimScenarioInput, SchemaError>` (validating, defaults materialised, all issues collected; does NOT normalise). `SimScenarioInput::normalized(self) -> Self`, `SimScenarioInput::content_hash(&self) -> Result<String, CoreError>` (= trace header inputHash after normalize), `physics_mode()`, `resolved_physics() -> PhysicsConfig`, `clip_ticks()`, `warmup_ticks()`, `effective_perception() -> Cow<PerceptionConfig>`, `actor(id)`. Crate root also re-exports `load_scenario(&[u8])` = `parse_scenario_input_bytes`.

Type aliases: `Id = String`, `LaneRsl = String`. `SCHEMA_VERSION: u32 = 1`. `DEFAULT_MOTION_PHYSICS_MODE = MotionPhysicsMode::DynamicV1`.

String enums (all Copy/Eq/Hash/Ord, `as_str()`, `parse(&str)`, `ALL`, Display, serde as string; trait `StrEnum`):
ControlIndication{Green,Yellow,Red,FlashingYellow,FlashingRed,Off,GreenArrow,YellowArrow,RedX,Proceed,Stop,FlashingYellowArrow,FlashingRedArrow}; DynamicsShape{Step,Linear,Sinusoidal,Cubic}; DynamicsConstraint{Rate,Time,Distance}; TurnRelation{Straight,Left,Right,UTurnLeft,UTurnRight}; ActorKind{Vehicle,Car,Truck,Bus,Van,Motorcycle,Bicycle,Pedestrian,Scooter,SidewalkRobot,Drone,Animal,StaticObject} + `default_dims()`, `is_pedestrian_like()`, `is_knockdown_vulnerable()`, `is_road_actor()`; GapMode{Time,Distance}; LaneOffsetMode{Meters,Fraction}; ExistState{Present,Absent}; DistanceMode{AlongLane,Euclidean}; Comparison{Lt,Lte,Gt,Gte} + `holds(value, threshold)`, `is_upper_bound()`; InteractionEvent{Start,End}; IfNever{Skip,Fire}; DarkFallback{AllWayStop,Uncontrolled,Yield}; TimingSource{Map,SyntheticDefault,Authored}; ControlBindingSource{Map,Authored}; RoadControlKind{Stop}; PropEssentiality{Required,Preferred,Cosmetic}; PassSide{Front,Behind}; Weather{Clear,Rain,Overcast}; TimeOfDay{Day,Dusk,Night,Dawn}; TrafficLevel{Light,Moderate,Heavy}; VisibilityClass{Unrestricted,ReducedContrast,HeadlightLimited,DirectionalGlare,DenseOcclusion}; MotionPhysicsMode{DynamicV1} (+ `LEGACY_KINEMATIC_PHYSICS_MODE: &str = "kinematic-v1"`, migrated to DynamicV1 on parse); SurfaceKind{Ice,PackedSnow,StandingWater,WetLeaves,LooseGravel,Sand,SpilledOil,PolishedAsphalt,GritTreated} + `friction_scale()`; SensorType{DashCamera,Lidar,Radar}; MapDivergenceKind{8 kinds}; RuleKey{ObeySignals,Yield,YieldToVehicles,YieldToPedestrians,CollisionAvoidance,Aggression,SpeedFactor}.

Structs/enums:
- `ScenePoint { x, z }` (+ `to_local() -> Vec2`), `LaneRef { rsl, s, t_frac }`, `Pose { x, z, heading_rad }` (+ `position_local()`), `Dims { l, w, h }`, `Dynamics { shape, constraint, value }`, `TimedPoint { time_s, x, z }`.
- `RouteSpec` (tag kind): `LanePath { lanes: Vec<LaneRsl> }`, `Follow { start_rsl, turns: Vec<TurnRelation>, max_length_m }`, `Polyline { points: Vec<ScenePoint> }`, `TimedPolyline { points: Vec<TimedPoint> }`.
- `RouteActionTarget { Spec(RouteSpec), NextJunction { turn, max_length_m } }`.
- `ActorRules { obey_signals, yield_to_vehicles, yield_to_pedestrians, collision_avoidance, aggression, speed_factor }` (Default). The `rules` object is strict; there is no master `yield` switch.
- `DrivingProfile { comfortable_lateral_acceleration_mps2, comfortable_deceleration_mps2 }`.
- `ActorInitial { lane_ref: Option<LaneRef>, pose: Pose, speed_mps }`; `ActorBehavior { rules, route: RouteSpec, driving_profile: Option<DrivingProfile>, cruise_speed_mps: Option<f64> }`.
- `SimActor { id, kind: ActorKind, dims: Dims (always materialised), initial, behavior, present_at_start, is_static (wire "static"; true for static_object), tags: Vec<String>, sensors: Option<Vec<SimSensor>> }` + `sensors() -> &[SimSensor]`, `has_tag()`.
- `SpeedTarget` (tag mode): `Absolute{value}`, `Delta{value}`, `Factor{value}`, `Match{actor_id, offset_mps}`, `Stop`.
- `LaneChangeTarget` (tag mode): `Left{count: u8}`, `Right{count}`, `Lane{rsl}`, `ActorLane{actor_id}`.
- `GapTarget { actor_id }`, `LaneOffsetTarget { mode: LaneOffsetMode, value }`, `ExistTarget { state: ExistState }`.
- `SetKey { Rule(RuleKey), Motion(String), Lights(String), Audio(String), Doors(String), Pose(String), Env(String), SignalPhase(Id), ControlIndication(Id) }` + `parse()`, Display (original key string). `SetValue { Bool(bool), Number(f64), Text(String) }` + `truthy()`. `SetTarget { key, value }`.
- `Verb` (tag verb): `Speed{target: SpeedTarget, dynamics}`, `Gap{target: GapTarget, value, mode: GapMode, dynamics}`, `ChangeLane{target: LaneChangeTarget, dynamics}`, `LaneOffset{target: LaneOffsetTarget, dynamics}`, `Route{target: RouteActionTarget, join_from_current_pose: Option<bool>, best_effort_world_path: Option<bool>}`, `Exist{target: ExistTarget}`, `Set{target: SetTarget}`.
- `Region` (tag kind): `Circle{center: ScenePoint, radius_m}`, `Polygon{points}`, `LaneWindow{rsl, s_min, s_max}`.
- `SurfacePatch { id, kind: SurfaceKind, region, friction_scale: Option<f64>, edge_taper_m, label: Option<String> }` + `effective_friction_scale()`.
- `LeafCondition` (tag kind): `Distance{a,b,mode: DistanceMode,cmp,value,hysteresis: Option<f64>}`, `Ttc{a,b,cmp,value}`, `Headway{a,b,cmp,value}`, `Reaches{actor_id, region}`, `Speed{actor_id,cmp,value}`, `Standstill{actor_id, duration_s}`, `Signal{signal_id, phase: ControlIndication}`, `Collision{a: Option<Id>, b: Option<Id>}`, `Visible{a, to, value: bool}`, `Detected{a, by, sensor: Option<Id>, value: bool}`.
- `Condition { Leaf(LeafCondition), And(Vec<LeafCondition>), Or(Vec<LeafCondition>), Not(LeafCondition) }` + `leaves()`; serialises as the TS shape.
- `LaneStation { rsl, s }`, `ReferenceFrame { stations }`, `ArrivalPoint { Point{at: ScenePoint, reference_frame: Option<ReferenceFrame>}, LaneS{rsl, s} }`, `ArrivalSpec { of, at, sync_with, ttc: Option<f64>, delta_t: Option<f64> }` + `ttc_s()`.
- `Trigger` (tag kind): `At{t}`, `After{interaction_id, event: Option<InteractionEvent>, delay_s}`, `When{condition: Condition, by_latest, if_never: IfNever}`, `Arrival{arrival: ArrivalSpec}`.
- `InteractionWindow { start_s, end_s }`; `Interaction { id, actor_id, trigger, window: Option<InteractionWindow>, until: Option<Condition>, verb: Verb (flattened) }`.
- `SignalPhase { phase, duration_s }`, `StopLine { rsl, s, connecting_lane_rsls }`, `ControllerHeadGroup { controller_id, head_ids }`, `SignalMapBinding { junction_id, controller_ids, head_ids, controller_head_groups: Option<Vec<..>>, timing_source }`, `SignalProgram { id, phases, offset_s, loop_ (wire "loop"), dark_fallback: Option<DarkFallback>, dark_dwell_s: Option<f64>, stop_lines, map_binding: Option<SignalMapBinding> }` + `effective_dark_fallback()`, `cycle_s()`.
- `RoadControlMapBinding { junction_id, control_ids, source }`, `RoadControl { id, kind: RoadControlKind, dwell_s, stop_lines, map_binding: Option<..> }`.
- `PropAttachment { actor_id, longitudinal_m, lateral_m, height_m, heading_offset_rad }`, `OccludesPair { observer, target }`, `StaticProp { id, group_id: Option, catalog_id, pose, attachment: Option<PropAttachment>, dims, scale, collidable, essentiality, occludes: Option<OccludesPair>, target_reveal_to_conflict_s: Option<f64> }`.
- `OccluderObb { center: ScenePoint, length_m, width_m, heading_rad, height_m }` + `to_local() -> math::Obb`; `Occluder { id, group_id: Option, obb }`; `OcclusionPair { observer, target, occluder_id: Option<Id> }`.
- `NearMissCriterion { interaction_id, pedestrian_id, target_id, clearance_m, tolerance_m, pass: PassSide, plan_hash, predicted_closest_approach_s, predicted_time_gap_s }`.
- `ConditionEffects { visibility_range_m, friction_scale, traffic_speed_factor }` (Default), `OperationalConditions { weather, time_of_day, traffic, visibility, effects }` (Default).
- `VehiclePhysicsProfile` (21 `Option<f64>` fields, Default/Copy), `PhysicsConfig { mode, substep_s: Option<f64>, vehicle_profiles: Option<BTreeMap<Id, VehiclePhysicsProfile>> }` + `profile(id)`.
- Perception: `SensorRotation { yaw_rad, pitch_rad, roll_rad }`, `MountPosition { x, y, z }`, `SensorMount { position, rotation }`, `SensorAperture { horizontal_fov_deg, vertical_fov_deg, near_m, far_m }`, `SensorSensitivity { atmosphere, illumination, glare }`, `DetectionModel { contrast_threshold, min_angular_size_rad, min_illumination_frac, detect_confidence, degraded_confidence, sensitivity, latch_s }` + `DetectionModel::for_sensor(SensorType)`, `SimSensor { id, label: Option, enabled, mount, aperture, sensor_type (wire "type"), aspect_ratio: Option<f64> (dash camera only), detection }`, `Sun { azimuth_rad, elevation_rad, half_angle_rad, intensity }`, `Atmosphere { fog_visibility_m, precipitation_mm_per_h, illumination_frac, sun: Option<Sun> }`, `EmissiveGlare { state_keys, half_angle_rad, intensity, range_m, height_m }`, `MapDivergenceExtent { Lane{rsl, s_min: Option, s_max: Option}, Circle{center, radius_m} }`, `MapDivergence { id, kind, extent, severity, lateral_error_m: Option, observers: Vec<Id>, label: Option }`, `PerceptionConfig { atmosphere, emissive_glare, map_divergences }` (Default = clear air).
- `SimScenarioInput { schema_version: u32, map_id: String, clip_seconds, warmup_seconds, dt, seed: rng::Seed, physics: Option<PhysicsConfig>, operational_conditions, metric_subject: Option<Id>, actors, interactions, signal_programs, road_controls, surface_patches, props, occluders, occlusion_pairs, near_miss_criteria: Option<Vec<NearMissCriterion>>, perception: Option<PerceptionConfig> }`.

## Not in core (owned elsewhere)
Topology/LaneGraph/Route: `simforge_core::map` (MapGeometry). Physics backend: `simforge_core::physics` (RoadPhysics). Trace/semantic ledger/evaluation: `simforge_core::trace`, `simforge_core::evaluation` (NativeTraceMetrics). Engine loop, `StaticMapCollider`, RunOptions: `simforge_core::engine`, `simforge_core::solve` (EngineExecution). `ENGINE_VERSION` const lives at the crate root.
