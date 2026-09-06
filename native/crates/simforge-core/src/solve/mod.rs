//! Pre-run solvers: nominal free-flow motion, the arrival back-solver,
//! feasibility guards and pedestrian authoring solves. All deterministic,
//! allocation-light and independent of the tick loop.

pub mod arrival;
pub mod guards;
pub mod nominal;
pub mod pedestrian;

pub use arrival::{
    apply_arrival_solution, resolve_arrival_triggers, solve_arrival, ArrivalResolution,
    ArrivalSolution, ARRIVAL_TOLERANCE_M,
};
pub use guards::{
    check_feasibility, timed_route_feasibility_issues, COMFORT_DECEL_MPS2, HARD_DECEL_MPS2,
};
pub use nominal::{
    action_aware_runway_need_m, nominal_run, nominal_runway_need_m, NominalActor, NominalProbe,
    NominalRunOptions,
};
pub use pedestrian::{
    plan_hash, resolve_pedestrian_projection, solve_pedestrian_near_miss, NearMissPass,
    PedestrianNearMissDiagnostic, PedestrianNearMissIssueCode, PedestrianNearMissRequest,
    PedestrianNearMissSolution, PedestrianProjection, PedestrianProjectionMovement,
    PedestrianProjectionSegment, PedestrianProjectionSegmentKind, PedestrianTriggerPoint,
    TimedTrajectoryPoint,
};
