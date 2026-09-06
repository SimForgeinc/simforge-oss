//! Class-level effective vehicle parameters and per-actor override
//! resolution. Values model a representative class, not a particular make,
//! are deliberately conservative, and remain overrideable per actor through
//! the hash-covered [`VehiclePhysicsProfile`] envelope.

use serde::{Deserialize, Serialize};

use super::motion::PhysicsError;
use crate::types::{ActorKind, VehiclePhysicsProfile};

/// Which integrator a class runs through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DynamicsModel {
    /// Planar single-track (bicycle) model with tyre friction ellipses.
    SingleTrack,
    /// Bounded social-force-style point agent without wheel/tyre semantics.
    PedestrianAgent,
}

/// Fully resolved physical parameters for one body.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVehiclePhysicsProfile {
    pub kind: ActorKind,
    pub dynamics_model: DynamicsModel,
    pub mass_kg: f64,
    pub yaw_inertia_kg_m2: f64,
    pub wheelbase_m: f64,
    pub cg_to_front_m: f64,
    pub cg_height_m: f64,
    pub wheel_radius_m: f64,
    pub cornering_stiffness_front_n_per_rad: f64,
    pub cornering_stiffness_rear_n_per_rad: f64,
    pub drag_coefficient_n_per_mps2: f64,
    pub rolling_resistance_coefficient: f64,
    pub max_drive_force_n: f64,
    pub max_brake_force_n: f64,
    pub max_steer_rad: f64,
    pub steer_rate_rad_per_s: f64,
    pub steer_time_constant_s: f64,
    pub tire_mu: f64,
    pub max_longitudinal_accel_mps2: f64,
    pub max_longitudinal_decel_mps2: f64,
    pub max_jerk_mps3: f64,
    pub max_lateral_acceleration_mps2: f64,
    pub max_yaw_rate_radps: f64,
}

/// Calibrated generic 1.5-tonne passenger car; not a make/model claim.
pub const GENERIC_PASSENGER_CAR_PROFILE: ResolvedVehiclePhysicsProfile =
    ResolvedVehiclePhysicsProfile {
        kind: ActorKind::Car,
        dynamics_model: DynamicsModel::SingleTrack,
        mass_kg: 1_500.0,
        yaw_inertia_kg_m2: 2_500.0,
        wheelbase_m: 2.7,
        cg_to_front_m: 1.2,
        cg_height_m: 0.55,
        wheel_radius_m: 0.31,
        cornering_stiffness_front_n_per_rad: 82_000.0,
        cornering_stiffness_rear_n_per_rad: 88_000.0,
        drag_coefficient_n_per_mps2: 0.42,
        rolling_resistance_coefficient: 0.012,
        max_drive_force_n: 5_500.0,
        max_brake_force_n: 13_500.0,
        max_steer_rad: 0.58,
        steer_rate_rad_per_s: 4.5,
        steer_time_constant_s: 0.12,
        tire_mu: 1.0,
        max_longitudinal_accel_mps2: 3.7,
        max_longitudinal_decel_mps2: 9.0,
        max_jerk_mps3: 8.0,
        max_lateral_acceleration_mps2: 7.0,
        max_yaw_rate_radps: 1.8,
    };

const VEHICLE_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Vehicle,
    ..GENERIC_PASSENGER_CAR_PROFILE
};

const VAN_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Van,
    mass_kg: 2_600.0,
    yaw_inertia_kg_m2: 5_200.0,
    wheelbase_m: 3.35,
    cg_to_front_m: 1.55,
    cg_height_m: 0.78,
    wheel_radius_m: 0.36,
    cornering_stiffness_front_n_per_rad: 105_000.0,
    cornering_stiffness_rear_n_per_rad: 118_000.0,
    drag_coefficient_n_per_mps2: 0.72,
    rolling_resistance_coefficient: 0.014,
    max_drive_force_n: 7_500.0,
    max_brake_force_n: 22_000.0,
    max_steer_rad: 0.54,
    steer_rate_rad_per_s: 2.5,
    steer_time_constant_s: 0.2,
    tire_mu: 0.92,
    max_longitudinal_accel_mps2: 2.5,
    max_longitudinal_decel_mps2: 7.2,
    max_jerk_mps3: 5.0,
    max_lateral_acceleration_mps2: 5.0,
    max_yaw_rate_radps: 1.25,
    ..GENERIC_PASSENGER_CAR_PROFILE
};

const TRUCK_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Truck,
    mass_kg: 12_000.0,
    yaw_inertia_kg_m2: 48_000.0,
    wheelbase_m: 5.2,
    cg_to_front_m: 2.25,
    cg_height_m: 1.25,
    wheel_radius_m: 0.5,
    cornering_stiffness_front_n_per_rad: 230_000.0,
    cornering_stiffness_rear_n_per_rad: 310_000.0,
    drag_coefficient_n_per_mps2: 2.1,
    rolling_resistance_coefficient: 0.009,
    max_drive_force_n: 42_000.0,
    max_brake_force_n: 92_000.0,
    max_steer_rad: 0.44,
    steer_rate_rad_per_s: 0.75,
    steer_time_constant_s: 0.38,
    tire_mu: 0.78,
    max_longitudinal_accel_mps2: 1.5,
    max_longitudinal_decel_mps2: 5.5,
    max_jerk_mps3: 2.5,
    max_lateral_acceleration_mps2: 3.1,
    max_yaw_rate_radps: 0.65,
    ..GENERIC_PASSENGER_CAR_PROFILE
};

const BUS_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Bus,
    mass_kg: 13_500.0,
    yaw_inertia_kg_m2: 66_000.0,
    wheelbase_m: 6.0,
    cg_to_front_m: 2.7,
    cg_height_m: 1.15,
    wheel_radius_m: 0.51,
    cornering_stiffness_front_n_per_rad: 250_000.0,
    cornering_stiffness_rear_n_per_rad: 330_000.0,
    drag_coefficient_n_per_mps2: 1.85,
    rolling_resistance_coefficient: 0.01,
    max_drive_force_n: 39_000.0,
    max_brake_force_n: 105_000.0,
    max_steer_rad: 0.46,
    steer_rate_rad_per_s: 0.68,
    steer_time_constant_s: 0.42,
    tire_mu: 0.8,
    max_longitudinal_accel_mps2: 1.35,
    max_longitudinal_decel_mps2: 5.2,
    max_jerk_mps3: 2.2,
    max_lateral_acceleration_mps2: 2.8,
    max_yaw_rate_radps: 0.58,
    ..GENERIC_PASSENGER_CAR_PROFILE
};

const MOTORCYCLE_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Motorcycle,
    mass_kg: 240.0,
    yaw_inertia_kg_m2: 145.0,
    wheelbase_m: 1.45,
    cg_to_front_m: 0.68,
    cg_height_m: 0.58,
    wheel_radius_m: 0.3,
    cornering_stiffness_front_n_per_rad: 14_000.0,
    cornering_stiffness_rear_n_per_rad: 17_000.0,
    drag_coefficient_n_per_mps2: 0.28,
    rolling_resistance_coefficient: 0.015,
    max_drive_force_n: 1_750.0,
    max_brake_force_n: 2_200.0,
    max_steer_rad: 0.62,
    steer_rate_rad_per_s: 3.2,
    steer_time_constant_s: 0.16,
    tire_mu: 0.95,
    max_longitudinal_accel_mps2: 4.8,
    max_longitudinal_decel_mps2: 8.2,
    max_jerk_mps3: 7.0,
    max_lateral_acceleration_mps2: 6.5,
    max_yaw_rate_radps: 2.4,
    ..GENERIC_PASSENGER_CAR_PROFILE
};

const BICYCLE_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Bicycle,
    mass_kg: 95.0,
    yaw_inertia_kg_m2: 28.0,
    wheelbase_m: 1.08,
    cg_to_front_m: 0.48,
    cg_height_m: 0.75,
    wheel_radius_m: 0.34,
    cornering_stiffness_front_n_per_rad: 1_100.0,
    cornering_stiffness_rear_n_per_rad: 1_350.0,
    drag_coefficient_n_per_mps2: 0.3,
    rolling_resistance_coefficient: 0.006,
    max_drive_force_n: 420.0,
    max_brake_force_n: 750.0,
    max_steer_rad: 0.7,
    steer_rate_rad_per_s: 2.2,
    steer_time_constant_s: 0.24,
    tire_mu: 0.82,
    max_longitudinal_accel_mps2: 1.8,
    max_longitudinal_decel_mps2: 5.0,
    max_jerk_mps3: 3.5,
    max_lateral_acceleration_mps2: 3.5,
    max_yaw_rate_radps: 2.1,
    ..GENERIC_PASSENGER_CAR_PROFILE
};

const SCOOTER_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Scooter,
    mass_kg: 115.0,
    yaw_inertia_kg_m2: 34.0,
    wheelbase_m: 1.15,
    cg_to_front_m: 0.52,
    cg_height_m: 0.67,
    wheel_radius_m: 0.25,
    cornering_stiffness_front_n_per_rad: 1_800.0,
    cornering_stiffness_rear_n_per_rad: 2_100.0,
    drag_coefficient_n_per_mps2: 0.32,
    rolling_resistance_coefficient: 0.012,
    max_drive_force_n: 620.0,
    max_brake_force_n: 950.0,
    max_steer_rad: 0.68,
    steer_rate_rad_per_s: 2.5,
    steer_time_constant_s: 0.2,
    tire_mu: 0.86,
    max_longitudinal_accel_mps2: 2.4,
    max_longitudinal_decel_mps2: 5.8,
    max_jerk_mps3: 4.0,
    max_lateral_acceleration_mps2: 3.8,
    max_yaw_rate_radps: 2.2,
    ..GENERIC_PASSENGER_CAR_PROFILE
};

const SIDEWALK_ROBOT_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::SidewalkRobot,
    dynamics_model: DynamicsModel::PedestrianAgent,
    mass_kg: 70.0,
    yaw_inertia_kg_m2: 18.0,
    wheelbase_m: 0.55,
    cg_to_front_m: 0.28,
    cg_height_m: 0.4,
    wheel_radius_m: 0.11,
    cornering_stiffness_front_n_per_rad: 1.0,
    cornering_stiffness_rear_n_per_rad: 1.0,
    drag_coefficient_n_per_mps2: 0.09,
    rolling_resistance_coefficient: 0.012,
    max_drive_force_n: 420.0,
    max_brake_force_n: 650.0,
    max_steer_rad: 0.01,
    steer_rate_rad_per_s: 0.01,
    steer_time_constant_s: 0.2,
    tire_mu: 0.85,
    max_longitudinal_accel_mps2: 1.8,
    max_longitudinal_decel_mps2: 3.5,
    max_jerk_mps3: 4.0,
    max_lateral_acceleration_mps2: 2.0,
    max_yaw_rate_radps: 3.0,
};

const DRONE_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Drone,
    dynamics_model: DynamicsModel::PedestrianAgent,
    mass_kg: 12.0,
    yaw_inertia_kg_m2: 4.0,
    wheelbase_m: 0.5,
    cg_to_front_m: 0.25,
    cg_height_m: 0.25,
    wheel_radius_m: 0.08,
    cornering_stiffness_front_n_per_rad: 1.0,
    cornering_stiffness_rear_n_per_rad: 1.0,
    drag_coefficient_n_per_mps2: 0.16,
    rolling_resistance_coefficient: 0.0,
    max_drive_force_n: 500.0,
    max_brake_force_n: 600.0,
    max_steer_rad: 0.01,
    steer_rate_rad_per_s: 0.01,
    steer_time_constant_s: 0.1,
    tire_mu: 1.0,
    max_longitudinal_accel_mps2: 3.0,
    max_longitudinal_decel_mps2: 5.0,
    max_jerk_mps3: 8.0,
    max_lateral_acceleration_mps2: 4.0,
    max_yaw_rate_radps: 4.0,
};

const PEDESTRIAN_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Pedestrian,
    dynamics_model: DynamicsModel::PedestrianAgent,
    mass_kg: 78.0,
    yaw_inertia_kg_m2: 9.0,
    wheelbase_m: 0.5,
    cg_to_front_m: 0.25,
    cg_height_m: 0.9,
    wheel_radius_m: 0.16,
    cornering_stiffness_front_n_per_rad: 1.0,
    cornering_stiffness_rear_n_per_rad: 1.0,
    drag_coefficient_n_per_mps2: 0.08,
    rolling_resistance_coefficient: 0.0,
    max_drive_force_n: 350.0,
    max_brake_force_n: 500.0,
    max_steer_rad: 0.01,
    steer_rate_rad_per_s: 0.01,
    steer_time_constant_s: 0.25,
    tire_mu: 0.9,
    max_longitudinal_accel_mps2: 1.6,
    max_longitudinal_decel_mps2: 3.2,
    max_jerk_mps3: 4.0,
    max_lateral_acceleration_mps2: 1.8,
    max_yaw_rate_radps: 3.0,
};

const ANIMAL_PROFILE: ResolvedVehiclePhysicsProfile = ResolvedVehiclePhysicsProfile {
    kind: ActorKind::Animal,
    dynamics_model: DynamicsModel::PedestrianAgent,
    mass_kg: 45.0,
    yaw_inertia_kg_m2: 5.0,
    wheelbase_m: 0.5,
    cg_to_front_m: 0.25,
    cg_height_m: 0.5,
    wheel_radius_m: 0.14,
    cornering_stiffness_front_n_per_rad: 1.0,
    cornering_stiffness_rear_n_per_rad: 1.0,
    drag_coefficient_n_per_mps2: 0.08,
    rolling_resistance_coefficient: 0.0,
    max_drive_force_n: 310.0,
    max_brake_force_n: 390.0,
    max_steer_rad: 0.01,
    steer_rate_rad_per_s: 0.01,
    steer_time_constant_s: 0.2,
    tire_mu: 0.9,
    max_longitudinal_accel_mps2: 2.5,
    max_longitudinal_decel_mps2: 3.8,
    max_jerk_mps3: 5.0,
    max_lateral_acceleration_mps2: 2.5,
    max_yaw_rate_radps: 3.5,
};

/// Every moving class profile, one per non-static [`ActorKind`].
const ACTOR_PHYSICS_PROFILES: [ResolvedVehiclePhysicsProfile; 12] = [
    VEHICLE_PROFILE,
    GENERIC_PASSENGER_CAR_PROFILE,
    VAN_PROFILE,
    TRUCK_PROFILE,
    BUS_PROFILE,
    MOTORCYCLE_PROFILE,
    BICYCLE_PROFILE,
    SCOOTER_PROFILE,
    SIDEWALK_ROBOT_PROFILE,
    DRONE_PROFILE,
    PEDESTRIAN_PROFILE,
    ANIMAL_PROFILE,
];

/// Class defaults for every moving actor kind (no `static_object` entry).
pub fn actor_physics_profiles() -> &'static [ResolvedVehiclePhysicsProfile] {
    &ACTOR_PHYSICS_PROFILES
}

/// Class defaults for one kind; `None` for `static_object`, which has no plant.
pub fn actor_physics_profile(kind: ActorKind) -> Option<&'static ResolvedVehiclePhysicsProfile> {
    let profile = match kind {
        ActorKind::Vehicle => &VEHICLE_PROFILE,
        ActorKind::Car => &GENERIC_PASSENGER_CAR_PROFILE,
        ActorKind::Van => &VAN_PROFILE,
        ActorKind::Truck => &TRUCK_PROFILE,
        ActorKind::Bus => &BUS_PROFILE,
        ActorKind::Motorcycle => &MOTORCYCLE_PROFILE,
        ActorKind::Bicycle => &BICYCLE_PROFILE,
        ActorKind::Scooter => &SCOOTER_PROFILE,
        ActorKind::SidewalkRobot => &SIDEWALK_ROBOT_PROFILE,
        ActorKind::Drone => &DRONE_PROFILE,
        ActorKind::Pedestrian => &PEDESTRIAN_PROFILE,
        ActorKind::Animal => &ANIMAL_PROFILE,
        ActorKind::StaticObject => return None,
    };
    Some(profile)
}

/// Catalog override for `catalog:pedestrian.child` actors: a 32 kg walker with
/// proportionally lower inertia, centre of gravity and force limits. Applied by
/// the engine underneath any authored per-actor override.
pub fn child_pedestrian_physics_profile() -> VehiclePhysicsProfile {
    VehiclePhysicsProfile {
        mass_kg: Some(32.0),
        yaw_inertia_kg_m2: Some(3.2),
        cg_height_m: Some(0.58),
        max_drive_force_n: Some(145.0),
        max_brake_force_n: Some(205.0),
        ..VehiclePhysicsProfile::default()
    }
}

#[inline]
fn positive(field: &'static str, value: Option<f64>, base: f64) -> Result<f64, PhysicsError> {
    match value {
        None => Ok(base),
        Some(v) if v.is_finite() && v > 0.0 => Ok(v),
        Some(v) => Err(PhysicsError::InvalidProfileValue {
            field,
            requirement: "positive",
            value: v,
        }),
    }
}

#[inline]
fn non_negative(field: &'static str, value: Option<f64>, base: f64) -> Result<f64, PhysicsError> {
    match value {
        None => Ok(base),
        Some(v) if v.is_finite() && v >= 0.0 => Ok(v),
        Some(v) => Err(PhysicsError::InvalidProfileValue {
            field,
            requirement: "non-negative",
            value: v,
        }),
    }
}

/// Resolve the effective profile for a moving actor: class defaults overlaid
/// with the authored override. The schema validates authored input; these
/// relational checks also protect direct library callers and keep axle
/// geometry physically meaningful.
pub fn resolve_actor_physics_profile(
    kind: ActorKind,
    over: Option<&VehiclePhysicsProfile>,
) -> Result<ResolvedVehiclePhysicsProfile, PhysicsError> {
    let base = actor_physics_profile(kind).ok_or_else(|| PhysicsError::StaticActor {
        actor_id: String::from(kind.as_str()),
    })?;
    let Some(o) = over else { return Ok(*base) };
    let profile = ResolvedVehiclePhysicsProfile {
        kind,
        dynamics_model: base.dynamics_model,
        mass_kg: positive("massKg", o.mass_kg, base.mass_kg)?,
        yaw_inertia_kg_m2: positive(
            "yawInertiaKgM2",
            o.yaw_inertia_kg_m2,
            base.yaw_inertia_kg_m2,
        )?,
        wheelbase_m: positive("wheelbaseM", o.wheelbase_m, base.wheelbase_m)?,
        cg_to_front_m: positive("cgToFrontM", o.cg_to_front_m, base.cg_to_front_m)?,
        cg_height_m: non_negative("cgHeightM", o.cg_height_m, base.cg_height_m)?,
        wheel_radius_m: positive("wheelRadiusM", o.wheel_radius_m, base.wheel_radius_m)?,
        cornering_stiffness_front_n_per_rad: positive(
            "corneringStiffnessFrontNPerRad",
            o.cornering_stiffness_front_n_per_rad,
            base.cornering_stiffness_front_n_per_rad,
        )?,
        cornering_stiffness_rear_n_per_rad: positive(
            "corneringStiffnessRearNPerRad",
            o.cornering_stiffness_rear_n_per_rad,
            base.cornering_stiffness_rear_n_per_rad,
        )?,
        drag_coefficient_n_per_mps2: non_negative(
            "dragCoefficientNPerMps2",
            o.drag_coefficient_n_per_mps2,
            base.drag_coefficient_n_per_mps2,
        )?,
        rolling_resistance_coefficient: non_negative(
            "rollingResistanceCoefficient",
            o.rolling_resistance_coefficient,
            base.rolling_resistance_coefficient,
        )?,
        max_drive_force_n: positive(
            "maxDriveForceN",
            o.max_drive_force_n,
            base.max_drive_force_n,
        )?,
        max_brake_force_n: positive(
            "maxBrakeForceN",
            o.max_brake_force_n,
            base.max_brake_force_n,
        )?,
        max_steer_rad: positive("maxSteerRad", o.max_steer_rad, base.max_steer_rad)?,
        steer_rate_rad_per_s: positive(
            "steerRateRadPerS",
            o.steer_rate_rad_per_s,
            base.steer_rate_rad_per_s,
        )?,
        steer_time_constant_s: positive(
            "steerTimeConstantS",
            o.steer_time_constant_s,
            base.steer_time_constant_s,
        )?,
        tire_mu: positive("tireMu", o.tire_mu, base.tire_mu)?,
        max_longitudinal_accel_mps2: positive(
            "maxLongitudinalAccelMps2",
            o.max_longitudinal_accel_mps2,
            base.max_longitudinal_accel_mps2,
        )?,
        max_longitudinal_decel_mps2: positive(
            "maxLongitudinalDecelMps2",
            o.max_longitudinal_decel_mps2,
            base.max_longitudinal_decel_mps2,
        )?,
        max_jerk_mps3: positive("maxJerkMps3", o.max_jerk_mps3, base.max_jerk_mps3)?,
        max_lateral_acceleration_mps2: positive(
            "maxLateralAccelerationMps2",
            o.max_lateral_acceleration_mps2,
            base.max_lateral_acceleration_mps2,
        )?,
        max_yaw_rate_radps: positive(
            "maxYawRateRadps",
            o.max_yaw_rate_radps,
            base.max_yaw_rate_radps,
        )?,
    };
    if profile.cg_to_front_m >= profile.wheelbase_m {
        return Err(PhysicsError::InvalidAxleGeometry {
            cg_to_front_m: profile.cg_to_front_m,
            wheelbase_m: profile.wheelbase_m,
        });
    }
    Ok(profile)
}

/// Resolve a generic passenger-car profile with optional overrides.
pub fn resolve_vehicle_physics_profile(
    over: Option<&VehiclePhysicsProfile>,
) -> Result<ResolvedVehiclePhysicsProfile, PhysicsError> {
    resolve_actor_physics_profile(ActorKind::Car, over)
}
