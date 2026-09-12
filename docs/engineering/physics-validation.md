# Motion and physics truth contract

SimForge identifies executed motion semantics explicitly. `dynamic-v1` is the
only motion backend: every moving actor is a body in the planar force-based
solver. A document with no `physics` field runs it, which preserves older
input JSON and its content hash; a document that explicitly pinned the
removed `kinematic-v1` choreography model migrates to `dynamic-v1` when it is
parsed, and the migration is the only rewrite `resolvePhysicsConfig` ever
sees — it never relabels anything else. Trace format v3 records the selected
mode, actual substep, engine build, and the digest of any per-actor
vehicle-profile overrides, plus per-tick collision impulse/count telemetry.
OpenSCENARIO exports retain the same provenance in SimForge
properties/comments.

## Claims

`dynamic-v1` denotes the planar force-based backend: actuator lag, aero and
rolling road load, longitudinal load transfer, combined-slip axle friction
circles, an automatic gearbox with a torque curve, and rigid contact
impulses, integrated at 5 ms substeps. Everything the removed choreography
model used to serve is still executed, now under forces: authored routes and
freehand timed polylines are the path tracker's targets and its speed
profile, and scenario timing, interactions, traffic controls, lane motion,
criticality metrics and collision detection are unchanged.

The mode name alone does not establish CARLA parity. Claims are limited to
the maneuvers that pass the versioned golden suite in
`fixtures/physics/golden-maneuvers.v2.json`. Suspension, grade/camber,
deformable damage, externally validated crash loads, powertrain detail beyond
the gearbox/torque map, and CARLA engine-level parity remain out of scope
until each has a reference-backed validation gate.

## Acceptance gates

- Determinism: byte-identical output over 10 independent runs and actor-order
  permutation.
- Non-contact convergence: 5 ms versus 2.5 ms final error no greater than 2 cm
  position, 0.05 m/s speed, and 0.1 degree yaw.
- Longitudinal: acceleration, coast, and 100–0 km/h braking within 10% of a
  declared, versioned reference.
- Lateral: steady skidpad response within 5%, step-steer yaw gain within 10%,
  and bounded sideslip according to the selected vehicle profile.
- Tire/surface: resultant tire force no greater than `mu * Fz + 2%`; stopping
  distance worsens monotonically as friction decreases; split-mu is evaluated
  per tire or axle.
- Collision response: swept OBB contact prevents high-speed tunneling; a
  deterministic planar sequential-impulse solver applies restitution, Coulomb
  friction, angular response, persistent-contact stabilization, and
  depenetration. Resting penetration is at most 2 cm in the acceptance fixture,
  and isolated impacts must not create momentum or energy. Impulse magnitude
  is telemetry, not a certified crash-load or damage prediction.
- Knockdown: a contact whose normal impulse implies a velocity change above
  `BALANCE_RECOVERY_DELTA_V_MPS` (0.6 m/s) takes a pedestrian, animal, or
  sidewalk robot off its feet. The threshold is a balance-recovery limit, not an
  injury or crash-load claim: below it a walker absorbs the shove and keeps its
  route, above it the agent stops steering, keeps the impulse the solver gave it,
  and slides to rest under a 0.55 sliding-friction coefficient. Drones are
  excluded. The state is monotonic within a clip — nothing stands a body back up
  — and is recorded as `downSinceS` on the actor track plus a `knocked_down`
  event carrying the impulse. Posture is not simulated: the engine stays planar
  and holds the yaw the body was struck with, so lying down is presentation
  derived from `downSinceS` in the browser renderer. The CARLA adapter drives
  walkers kinematically and does not present the posture yet, so a managed
  render shows the body sliding to rest upright while the trace, the metrics and
  the browser preview agree it is down. OpenSCENARIO carries the translation in the replay
  polyline and declares the time in the stored-data-compatible trajectory replay
  header property, because the standard has no element for a body on the ground.
- Performance: 10 dynamic actors for 20 simulated seconds in at most 1 second
  offline (at least 20x real time) on the declared benchmark machine.
- Existing baked OpenSCENARIO replay: position RMSE at most 0.1 m, position p95
  at most 0.2 m, and heading p95 at most 1 degree.

The validation library reports failed and not-run gates; absence of a result is
never interpreted as a pass. Reference values must come from declared external
measurements or pinned profiles, not from the implementation under test.

## Versioning and evidence

Adding `physics` to an older scenario is a material input change and therefore
changes its input hash. Merely parsing an older scenario does not add the field,
so its input hash stays stable. Regenerating it under engine 0.3.0 or newer uses
the current `dynamic-v1` default and records that fact. Immutable traces from
before 0.3.0 remain `kinematic-v1` on replay; validators accept that historical
pair only when the input omitted physics and the recorded solver predates the
migration. They report it as `legacy-kinematic`, never as dynamic. A new trace
must match exactly. This prevents default changes from silently relabeling old
evidence.

A document that explicitly pinned `kinematic-v1` is a different case: the pin
migrates to `dynamic-v1` when the document is parsed, and since the mode is
hash-covered the migrated document hashes differently from the original. Such
a document keeps every feature and simulates again immediately; its archived
evidence keeps replaying from the recorded trace, but it no longer
hash-verifies against a re-parse of its own input, because the motion that
produced it is no longer available to reproduce. This is the deliberate cost
of removing the backend, recorded here rather than hidden behind a relabel.

Engine 0.4.0 / trace format v3 is the collision-response provenance boundary.
Explicit static actors, props, and `map:*` collision proxies are infinite-mass
contact bodies: they affect dynamic actors, but contacts never displace them.
