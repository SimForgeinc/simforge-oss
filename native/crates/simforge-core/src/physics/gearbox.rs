//! Per-class gearbox, engine-speed and torque map for `dynamic-v1`.
//!
//! The planar backend integrates a single longitudinal force; the drivetrain
//! decides how much of that force is available right now. Engine speed is read
//! back from the driven-wheel speed through the engaged gear, a normalised
//! torque curve shapes the available force with engine speed, and an automatic
//! shift schedule with a short clutch-less torque cut moves between gears.
//!
//! Calibration contract: a class's `max_drive_force_n` stays exactly what it
//! has always been — the tractive force available at peak torque at the
//! class's *calibration ratio*. Per-gear availability is
//! `max_drive_force_n × (overall_ratio / calibration_ratio) × torque_factor`.
//! The calibration ratio is deliberately not one of the gear ratios: it is set
//! so that the gear a class occupies through its golden acceleration maneuver
//! still delivers the calibrated force, which is what keeps the parity table
//! in `docs/engineering/physics-provenance.md` inside its published bands. Low
//! gears deliver more (the launch becomes tyre-limited rather than
//! force-limited, as it is in a real car) and cruise gears deliver less.

use crate::math::clamp;
use crate::types::ActorKind;

/// `rad/s → rev/min`.
const RADPS_TO_RPM: f64 = 60.0 / (2.0 * std::f64::consts::PI);

/// Neutral: stopped with a closed throttle.
pub const GEAR_NEUTRAL: i32 = 0;
/// The single reverse gear.
pub const GEAR_REVERSE: i32 = -1;

/// Below this speed a vehicle with no throttle applied sits in neutral.
const NEUTRAL_SPEED_MPS: f64 = 0.15;

/// Drivetrain of one vehicle class.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gearbox {
    /// Forward gear ratios, lowest (numerically highest) gear first.
    pub ratios: &'static [f64],
    pub reverse_ratio: f64,
    pub final_drive: f64,
    /// Overall ratio at which `max_drive_force_n` is the peak-torque tractive
    /// force. See the module note: this anchors the whole force map.
    pub calibration_ratio: f64,
    pub idle_rpm: f64,
    pub redline_rpm: f64,
    /// Automatic upshift threshold at part-to-full throttle.
    pub shift_up_rpm: f64,
    /// Automatic downshift threshold.
    pub shift_down_rpm: f64,
    /// Torque-cut duration of a clutch-less shift.
    pub shift_time_s: f64,
}

impl Gearbox {
    #[inline]
    pub fn top_gear(&self) -> i32 {
        self.ratios.len() as i32
    }

    /// Overall ratio (gearbox × final drive) of an engaged gear. Neutral has
    /// no path to the wheels and reports the first gear's ratio so engine
    /// speed still has a defined reference.
    #[inline]
    pub fn overall_ratio(&self, gear: i32) -> f64 {
        let ratio = if gear == GEAR_REVERSE {
            self.reverse_ratio
        } else if gear <= GEAR_NEUTRAL {
            self.ratios[0]
        } else {
            self.ratios[(gear as usize - 1).min(self.ratios.len() - 1)]
        };
        ratio * self.final_drive
    }

    /// Engine speed implied by the driven-wheel speed in the engaged gear.
    /// Neutral idles: the engine is disconnected from the wheels.
    #[inline]
    pub fn engine_rpm(&self, gear: i32, wheel_angular_speed_radps: f64) -> f64 {
        if gear == GEAR_NEUTRAL {
            return self.idle_rpm;
        }
        let rpm = wheel_angular_speed_radps.abs() * self.overall_ratio(gear) * RADPS_TO_RPM;
        clamp(rpm, self.idle_rpm, self.redline_rpm)
    }

    /// Normalised torque available at an engine speed: 1.0 across the torque
    /// plateau, less off-plateau. A generic curve shape (soft below the
    /// plateau, tapering past peak power) rather than a particular engine map.
    pub fn torque_factor(&self, rpm: f64) -> f64 {
        let f = clamp(rpm / self.redline_rpm, 0.0, 1.0);
        const CURVE: [(f64, f64); 7] = [
            (0.00, 0.55),
            (0.15, 0.80),
            (0.30, 0.95),
            (0.45, 1.00),
            (0.72, 1.00),
            (0.88, 0.93),
            (1.00, 0.80),
        ];
        for window in CURVE.windows(2) {
            let (x0, y0) = window[0];
            let (x1, y1) = window[1];
            if f <= x1 {
                return y0 + (y1 - y0) * (f - x0) / (x1 - x0);
            }
        }
        CURVE[CURVE.len() - 1].1
    }

    /// Tractive force available at full throttle in `gear` at `rpm`, as a
    /// multiple of the class's `max_drive_force_n`.
    #[inline]
    pub fn drive_force_factor(&self, gear: i32, rpm: f64) -> f64 {
        if gear == GEAR_NEUTRAL {
            return 0.0;
        }
        self.overall_ratio(gear) / self.calibration_ratio * self.torque_factor(rpm)
    }

    /// The gear an automatic would be in, given the engaged gear and the
    /// current driveline state. Returns `(gear, shifted)`; `shifted` asks the
    /// caller to start a torque cut.
    ///
    /// `demand` is how the driver is asking the car to move. A scenario actor
    /// states its direction outright; a live driver only has two pedals, so
    /// the selector implements the convention every automatic has: hold the
    /// brake at a standstill and it takes reverse, squeeze the throttle at a
    /// standstill in reverse and it takes drive.
    pub fn select(
        &self,
        engaged: i32,
        longitudinal_velocity_mps: f64,
        wheel_angular_speed_radps: f64,
        demand: GearDemand,
    ) -> (i32, bool) {
        let stopped = longitudinal_velocity_mps.abs() < NEUTRAL_SPEED_MPS;
        let (reverse, throttle) = match demand {
            GearDemand::Authored { reverse, throttle } => (reverse, throttle),
            GearDemand::Pedals { throttle, brake } => {
                let reverse = if engaged == GEAR_REVERSE {
                    // Stay in reverse until the driver asks to pull away
                    // forwards from a standstill.
                    !(stopped && throttle > 0.0 && brake <= 0.0)
                } else {
                    stopped && brake > 0.0 && throttle <= 0.0
                };
                // In reverse the brake pedal is the one asking for motion.
                (reverse, if reverse { brake } else { throttle })
            }
        };
        if reverse {
            return (GEAR_REVERSE, engaged != GEAR_REVERSE);
        }
        if stopped && throttle <= 0.0 {
            // Coming to rest with a closed throttle: an automatic sits in
            // neutral/idle rather than lugging the engine at zero rpm.
            return (GEAR_NEUTRAL, false);
        }
        let from = if engaged <= GEAR_NEUTRAL { 1 } else { engaged };
        let rpm = self.engine_rpm(from, wheel_angular_speed_radps);
        if rpm >= self.shift_up_rpm && from < self.top_gear() {
            return (from + 1, true);
        }
        if rpm <= self.shift_down_rpm && from > 1 {
            return (from - 1, true);
        }
        (from, from != engaged)
    }
}

/// What the gear selector is being asked for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GearDemand {
    /// Scenario choreography, which states its travel direction.
    Authored { reverse: bool, throttle: f64 },
    /// A live driver, who has only a throttle and a brake.
    Pedals { throttle: f64, brake: f64 },
}

/// Five-speed automatic behind a generic 1.5-tonne passenger car. Gear 1 tops
/// out near 46 km/h and third carries the car through 100 km/h, which is where
/// the calibration ratio is anchored.
const PASSENGER_CAR_GEARBOX: Gearbox = Gearbox {
    ratios: &[3.55, 2.10, 1.45, 1.05, 0.82],
    reverse_ratio: 3.20,
    final_drive: 4.30,
    calibration_ratio: 6.20,
    idle_rpm: 800.0,
    redline_rpm: 6_500.0,
    shift_up_rpm: 6_000.0,
    shift_down_rpm: 1_500.0,
    shift_time_s: 0.06,
};

/// Light-commercial five-speed: longer first gear, lower redline than a car.
const VAN_GEARBOX: Gearbox = Gearbox {
    ratios: &[4.10, 2.30, 1.50, 1.05, 0.80],
    reverse_ratio: 3.70,
    final_drive: 4.10,
    calibration_ratio: 6.15,
    idle_rpm: 750.0,
    redline_rpm: 4_800.0,
    shift_up_rpm: 4_300.0,
    shift_down_rpm: 1_200.0,
    shift_time_s: 0.09,
};

/// Heavy diesel: many closely spaced ratios, a narrow rev band, and slow
/// shifts — the reason a truck's acceleration is stepped rather than smooth.
const TRUCK_GEARBOX: Gearbox = Gearbox {
    ratios: &[9.00, 6.20, 4.35, 3.05, 2.15, 1.50, 1.05, 0.78],
    reverse_ratio: 8.50,
    final_drive: 3.70,
    calibration_ratio: 11.30,
    idle_rpm: 600.0,
    redline_rpm: 2_400.0,
    shift_up_rpm: 2_100.0,
    shift_down_rpm: 1_050.0,
    shift_time_s: 0.35,
};

const BUS_GEARBOX: Gearbox = Gearbox {
    ratios: &[3.49, 1.86, 1.41, 1.00, 0.75],
    reverse_ratio: 5.00,
    final_drive: 5.60,
    calibration_ratio: 7.90,
    idle_rpm: 600.0,
    redline_rpm: 2_500.0,
    shift_up_rpm: 2_150.0,
    shift_down_rpm: 1_050.0,
    shift_time_s: 0.30,
};

/// Sequential six-speed, high revs, very short shifts.
const MOTORCYCLE_GEARBOX: Gearbox = Gearbox {
    ratios: &[2.85, 2.05, 1.65, 1.40, 1.22, 1.10],
    reverse_ratio: 2.85,
    final_drive: 2.90,
    calibration_ratio: 4.79,
    idle_rpm: 1_200.0,
    redline_rpm: 11_000.0,
    shift_up_rpm: 10_000.0,
    shift_down_rpm: 3_200.0,
    shift_time_s: 0.04,
};

/// Single-ratio drive: electric scooters, delivery robots and drone rotors
/// have no gearbox, so the "engine" speed is just the driveline speed and the
/// force factor is flat.
const fn direct_drive(idle_rpm: f64, redline_rpm: f64, overall: f64) -> Gearbox {
    Gearbox {
        ratios: &[1.0],
        reverse_ratio: 1.0,
        final_drive: overall,
        calibration_ratio: overall,
        idle_rpm,
        redline_rpm,
        // A single-speed drive never shifts: put both thresholds outside the
        // reachable band rather than special-casing the schedule.
        shift_up_rpm: f64::INFINITY,
        shift_down_rpm: f64::NEG_INFINITY,
        shift_time_s: 0.0,
    }
}

const BICYCLE_GEARBOX: Gearbox = direct_drive(0.0, 260.0, 3.0);
const SCOOTER_GEARBOX: Gearbox = direct_drive(0.0, 1_200.0, 5.0);
const SIDEWALK_ROBOT_GEARBOX: Gearbox = direct_drive(0.0, 900.0, 8.0);
const DRONE_GEARBOX: Gearbox = direct_drive(0.0, 9_000.0, 1.0);

/// The drivetrain of a moving class, or `None` for classes with no driveline
/// at all (walkers and animals, which run the pedestrian point agent).
pub fn gearbox_for(kind: ActorKind) -> Option<&'static Gearbox> {
    let gearbox = match kind {
        ActorKind::Vehicle | ActorKind::Car => &PASSENGER_CAR_GEARBOX,
        ActorKind::Van => &VAN_GEARBOX,
        ActorKind::Truck => &TRUCK_GEARBOX,
        ActorKind::Bus => &BUS_GEARBOX,
        ActorKind::Motorcycle => &MOTORCYCLE_GEARBOX,
        ActorKind::Bicycle => &BICYCLE_GEARBOX,
        ActorKind::Scooter => &SCOOTER_GEARBOX,
        ActorKind::SidewalkRobot => &SIDEWALK_ROBOT_GEARBOX,
        ActorKind::Drone => &DRONE_GEARBOX,
        ActorKind::Pedestrian | ActorKind::Animal | ActorKind::StaticObject => return None,
    };
    Some(gearbox)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Authored demand: the scenario states its direction and whether it is
    /// asking for drive.
    const DRIVE: GearDemand = GearDemand::Authored {
        reverse: false,
        throttle: 1.0,
    };

    #[test]
    fn upshifts_at_the_schedule_and_holds_the_top_gear() {
        let g = &PASSENGER_CAR_GEARBOX;
        // Wheel speed that puts first gear past the upshift threshold.
        let omega = g.shift_up_rpm / (g.overall_ratio(1) * RADPS_TO_RPM) + 1.0;
        assert_eq!(g.select(1, 15.0, omega, DRIVE), (2, true));
        let fast = g.shift_up_rpm / (g.overall_ratio(5) * RADPS_TO_RPM) + 1.0;
        assert_eq!(g.select(5, 60.0, fast, DRIVE), (5, false));
    }

    #[test]
    fn idles_in_neutral_at_rest_and_engages_reverse() {
        let g = &PASSENGER_CAR_GEARBOX;
        let authored = |reverse, throttle| GearDemand::Authored { reverse, throttle };
        assert_eq!(g.select(1, 0.0, 0.0, authored(false, 0.0)), (GEAR_NEUTRAL, false));
        assert_eq!(g.engine_rpm(GEAR_NEUTRAL, 0.0), g.idle_rpm);
        assert_eq!(g.select(1, 0.0, 0.0, authored(false, 0.5)), (1, false));
        assert_eq!(
            g.select(1, -1.0, 3.0, authored(true, 0.4)),
            (GEAR_REVERSE, true)
        );
    }

    /// A live driver has no gear lever: the brake pedal at a standstill takes
    /// reverse, the throttle at a standstill takes drive again, and neither
    /// pedal changes direction while the car is rolling.
    #[test]
    fn pedals_alone_select_reverse_and_drive_at_a_standstill() {
        let g = &PASSENGER_CAR_GEARBOX;
        let pedals = |throttle, brake| GearDemand::Pedals { throttle, brake };
        assert_eq!(
            g.select(GEAR_NEUTRAL, 0.0, 0.0, pedals(0.0, 0.6)),
            (GEAR_REVERSE, true)
        );
        // Holding the brake in reverse is the request to keep reversing.
        assert_eq!(
            g.select(GEAR_REVERSE, -2.0, 6.0, pedals(0.0, 0.6)),
            (GEAR_REVERSE, false)
        );
        // Throttle at a standstill pulls away forwards; leaving reverse for
        // first is a real gear change, so the selector asks for a cut.
        assert_eq!(
            g.select(GEAR_REVERSE, 0.0, 0.0, pedals(0.5, 0.0)),
            (1, true)
        );
        // Braking hard while still rolling forwards stays in a forward gear:
        // the brake only means "reverse" once the car has actually stopped.
        let (gear, _) = g.select(2, 8.0, 25.0, pedals(0.0, 1.0));
        assert!(gear > 0, "still rolling forwards, got gear {gear}");
    }

    #[test]
    fn force_factor_falls_off_through_the_gears() {
        let g = &PASSENGER_CAR_GEARBOX;
        let at_peak = |gear: i32| g.drive_force_factor(gear, g.redline_rpm * 0.5);
        assert!(at_peak(1) > at_peak(2) && at_peak(2) > at_peak(3));
        assert!(at_peak(3) > 1.0, "third gear carries the calibration point");
        assert!(at_peak(5) < 1.0);
        assert_eq!(g.drive_force_factor(GEAR_NEUTRAL, g.idle_rpm), 0.0);
    }
}
