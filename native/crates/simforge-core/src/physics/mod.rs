//! Planar roadway motion: the force-based `dynamic-v1` single-track /
//! pedestrian-agent backend, its class profiles, and the deterministic
//! sequential-impulse contact solver that couples every body after a tick.
//!
//! The outer engine owns triggers, routes, choreography and event authority.
//! This module owns *continuous body state*: it integrates one body per
//! [`MotionBackend::step`] call from a solver-neutral [`MotionIntent`], and
//! resolves all bodies together in [`DynamicV1Backend::step_world`] so
//! collision response, swept contact and downed-body sliding are physical
//! rather than a per-body approximation.
//!
//! [`TrafficHandoffWorld`] reuses the same contact solver for road users an
//! external traffic provider hands over on impact (the browser SUMO bridge):
//! ownership policy lives there, contact response lives in the solver.
//!
//! All quantities are SI in XODR-local planar coordinates (`x` east, `y`
//! north, headings CCW from `+x`). Body-frame velocities are longitudinal
//! (`u`, positive forward along the yaw axis) and lateral (`v`, positive
//! left).

mod collision;
mod dynamic_v1;
mod gearbox;
mod handoff;
mod motion;
mod profile;
#[cfg(test)]
mod tests;

pub use collision::{
    swept_obb_time_of_impact, CollisionImpulse, ContactPose, ContactRef, PlanarCollisionBody,
    PlanarContactSolver, PlanarStaticCollider, DEFAULT_CONTACT_FRICTION,
    DEFAULT_CONTACT_RESTITUTION,
};
pub use dynamic_v1::{
    DynamicV1Backend, WorldContact, WorldContactRef, WorldStaticCollider,
    BALANCE_RECOVERY_DELTA_V_MPS, DYNAMIC_V1_DEFAULT_SUBSTEP_S, DYNAMIC_V1_ID, DYNAMIC_V1_VERSION,
    SLIDING_FRICTION_COEFFICIENT, STANDARD_GRAVITY_MPS2,
};
pub use handoff::{
    HandoffActor, HandoffBody, HandoffOrigin, TrafficHandoffWorld, HANDOFF_MIN_IMPACT_SPEED_MPS,
    HANDOFF_RESTITUTION,
};
pub use gearbox::{gearbox_for, Gearbox, GEAR_NEUTRAL, GEAR_REVERSE};
pub use motion::{
    AxleUtilization, BodyIndex, MotionActorInitialization, MotionBackend, MotionDirection,
    MotionInitialState, MotionIntent, MotionStepResult, PhysicsError, PhysicsTelemetrySample,
    VehicleControl, VehicleMotionState, VehicleTelemetry,
};
pub use profile::{
    actor_physics_profile, actor_physics_profiles, child_pedestrian_physics_profile,
    resolve_actor_physics_profile, resolve_vehicle_physics_profile, DynamicsModel,
    ResolvedVehiclePhysicsProfile, GENERIC_PASSENGER_CAR_PROFILE,
};
