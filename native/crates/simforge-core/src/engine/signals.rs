//! Signal programs: a repeating phase timeline per signal id, plus the
//! stop-line arc lengths it controls, and static stop controls.
//!
//! The timeline starts at `t = -warmupSeconds + offsetS`, so a program is
//! already mid-cycle when the recorded clip begins.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::hash::cmp_utf16;
use crate::map::{build_lane_path_route, LaneGraph, LaneId, Route};
use crate::math::{angle_delta, js_round};
use crate::types::{
    ControlIndication, DarkFallback, RoadControl, SignalProgram, SimScenarioInput, StopLine,
    TimingSource,
};

const OVERLAPPING_CONTROL_LANE_TOLERANCE_M: f64 = 1.5;
const OVERLAPPING_CONTROL_HEADING_TOLERANCE_RAD: f64 = std::f64::consts::PI / 8.0;
/// Coarse projection step when matching a stop line onto a coincident lane;
/// finer than the route default so a 1.5 m tolerance is meaningful.
const OVERLAPPING_CONTROL_PROJECT_STEP_M: f64 = 0.5;

/// The law a dark head reverts to when the author has not said otherwise.
pub const DEFAULT_DARK_FALLBACK: DarkFallback = DarkFallback::AllWayStop;
/// Standstill required at a dark or flashing-red line when unspecified, seconds.
pub const DEFAULT_DARK_DWELL_S: f64 = 1.0;
/// Tick rate every tick-denominated snapshot field assumes by default.
pub const SIGNAL_SNAPSHOT_TICK_HZ: f64 = 50.0;

const SNAPSHOT_EPS_S: f64 = 1e-9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlSource {
    SignalPrograms,
    RoadControls,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlBindingRepair {
    pub source: ControlSource,
    pub control_id: String,
    pub source_rsl: String,
    pub route_rsl: String,
    pub distance_m: f64,
}

/// Bind physical controls across coincident, same-direction OpenDRIVE lane
/// identities. Returns the (possibly rewritten) input plus the repairs made.
pub fn resolve_overlapping_control_lanes(
    mut input: SimScenarioInput,
    graph: &Arc<LaneGraph>,
) -> (SimScenarioInput, Vec<ControlBindingRepair>) {
    let actor_lane_paths: Vec<&[String]> = input
        .actors
        .iter()
        .filter_map(|a| match &a.behavior.route {
            crate::types::RouteSpec::LanePath { lanes } => Some(lanes.as_slice()),
            _ => None,
        })
        .collect();
    let mut route_rsls: Vec<&str> = actor_lane_paths
        .iter()
        .flat_map(|l| l.iter().map(String::as_str))
        .collect();
    route_rsls.sort_unstable_by(|a, b| cmp_utf16(a, b));
    route_rsls.dedup();
    let route_by_rsl: BTreeMap<&str, Route> = route_rsls
        .iter()
        .filter_map(|rsl| {
            let lane = graph.lane_id(rsl)?;
            build_lane_path_route(graph, &[lane])
                .ok()
                .map(|r| (*rsl, r))
        })
        .collect();
    let mut repairs: Vec<ControlBindingRepair> = Vec::new();

    let repair_lines = |source: ControlSource,
                        control_id: &str,
                        lines: &[StopLine],
                        repairs: &mut Vec<ControlBindingRepair>|
     -> Vec<StopLine> {
        let mut repaired: Vec<StopLine> = lines.to_vec();
        let mut keys: Vec<(String, Vec<String>)> = lines
            .iter()
            .map(|l| (l.rsl.clone(), l.connecting_lane_rsls.clone()))
            .collect();
        for line in lines {
            let Some(source_lane) = graph.lane_id(&line.rsl) else {
                continue;
            };
            let sample = graph.sample_storage(source_lane, line.s);
            let source_heading = if graph.nominal_reversed(source_lane) == Some(true) {
                sample.heading_rad + std::f64::consts::PI
            } else {
                sample.heading_rad
            };
            for route_rsl in &route_rsls {
                if *route_rsl == line.rsl {
                    continue;
                }
                if keys
                    .iter()
                    .any(|(r, c)| r == route_rsl && *c == line.connecting_lane_rsls)
                {
                    continue;
                }
                if !line.connecting_lane_rsls.is_empty()
                    && !actor_lane_paths.iter().any(|lanes| {
                        lanes.iter().any(|l| l == route_rsl)
                            && line
                                .connecting_lane_rsls
                                .iter()
                                .any(|c| lanes.iter().any(|l| l == c))
                    })
                {
                    continue;
                }
                let Some(route) = route_by_rsl.get(route_rsl) else {
                    continue;
                };
                let projection =
                    route.project_point_with_step(sample.point, OVERLAPPING_CONTROL_PROJECT_STEP_M);
                if projection.d > OVERLAPPING_CONTROL_LANE_TOLERANCE_M {
                    continue;
                }
                let pose = route.pose_at(projection.s);
                if angle_delta(source_heading, pose.heading_rad).abs()
                    > OVERLAPPING_CONTROL_HEADING_TOLERANCE_RAD
                {
                    continue;
                }
                repaired.push(StopLine {
                    rsl: (*route_rsl).to_owned(),
                    s: pose.storage_s,
                    connecting_lane_rsls: line.connecting_lane_rsls.clone(),
                });
                keys.push(((*route_rsl).to_owned(), line.connecting_lane_rsls.clone()));
                repairs.push(ControlBindingRepair {
                    source,
                    control_id: control_id.to_owned(),
                    source_rsl: line.rsl.clone(),
                    route_rsl: (*route_rsl).to_owned(),
                    distance_m: projection.d,
                });
            }
        }
        repaired.sort_by(|a, b| {
            cmp_utf16(&a.rsl, &b.rsl)
                .then(a.s.partial_cmp(&b.s).unwrap_or(std::cmp::Ordering::Equal))
        });
        repaired
    };

    let program_lines: Vec<Vec<StopLine>> = input
        .signal_programs
        .iter()
        .map(|p| {
            repair_lines(
                ControlSource::SignalPrograms,
                &p.id,
                &p.stop_lines,
                &mut repairs,
            )
        })
        .collect();
    let control_lines: Vec<Vec<StopLine>> = input
        .road_controls
        .iter()
        .map(|c| {
            repair_lines(
                ControlSource::RoadControls,
                &c.id,
                &c.stop_lines,
                &mut repairs,
            )
        })
        .collect();
    // No repair leaves the executed input byte-identical to what was authored.
    if !repairs.is_empty() {
        for (program, lines) in input.signal_programs.iter_mut().zip(program_lines) {
            program.stop_lines = lines;
        }
        for (control, lines) in input.road_controls.iter_mut().zip(control_lines) {
            control.stop_lines = lines;
        }
    }
    (input, repairs)
}

pub type SignalPhaseValue = ControlIndication;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PhaseSource {
    Program,
    Override,
}

/// Observable phase plus the source that currently owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalState {
    pub phase: ControlIndication,
    pub source: PhaseSource,
    pub timing_source: TimingSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityKind {
    Signal,
    Stop,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityReason {
    Program,
    Blackout,
    FlashingRed,
    StaticStop,
    BlackoutUncontrolled,
}

/// What law a stop line is executing **right now**.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StopLineAuthority {
    pub kind: AuthorityKind,
    /// Minimum continuous standstill before release (meaningful for `Stop`).
    pub dwell_s: f64,
    pub reason: AuthorityReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignalFailureState {
    Off,
    FlashingRed,
}

/// Wire-ready truth about one signal at one instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalSnapshot {
    pub signal_id: String,
    pub head_ids: Vec<String>,
    pub controller_id: Option<String>,
    pub junction_id: Option<String>,
    pub phase: ControlIndication,
    pub source: PhaseSource,
    pub timing_source: TimingSource,
    pub phase_start_tick: Option<i64>,
    pub phase_end_tick: Option<i64>,
    pub remaining_ticks: Option<i64>,
    pub next_phase: Option<ControlIndication>,
    pub cycle_length_ticks: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_state: Option<SignalFailureState>,
}

fn failure_state_of(phase: ControlIndication) -> Option<SignalFailureState> {
    match phase {
        ControlIndication::Off => Some(SignalFailureState::Off),
        ControlIndication::FlashingRed | ControlIndication::FlashingRedArrow => {
            Some(SignalFailureState::FlashingRed)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopLineKind {
    Signal,
    Stop,
}

/// Dense handle for a control (signal program or road control) used by
/// per-actor road-control memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ControlSlot(pub u32);

#[derive(Debug, Clone, PartialEq)]
pub struct StopLineBinding {
    pub control: ControlSlot,
    /// Shared junction arbitration key (dense) for all-way-stop approaches.
    pub coordination: u32,
    pub kind: StopLineKind,
    /// Program index when `kind == Signal`.
    pub signal: Option<u32>,
    pub dwell_s: f64,
    pub lane: LaneId,
    /// Arc length in the lane's **storage** direction.
    pub s: f64,
    /// Empty means every movement; otherwise the route must contain one.
    pub connecting_lanes: Vec<LaneId>,
}

#[derive(Debug, Clone)]
struct ControlEntry {
    id: String,
}

#[derive(Debug, Clone)]
pub struct SignalBook {
    programs: Vec<SignalProgram>,
    program_index: BTreeMap<String, u32>,
    cycle_length: Vec<f64>,
    overrides: Vec<Option<ControlIndication>>,
    warmup_seconds: f64,
    controls: Vec<ControlEntry>,
    coordination_ids: Vec<String>,
    /// Sorted by `(lane, s)`.
    stop_lines: Vec<StopLineBinding>,
    /// `(lane, start, end)` ranges into `stop_lines`, sorted by lane.
    lane_ranges: Vec<(LaneId, u32, u32)>,
}

impl SignalBook {
    pub fn new(
        programs: &[SignalProgram],
        warmup_seconds: f64,
        road_controls: &[RoadControl],
        graph: &LaneGraph,
    ) -> Self {
        let mut programs: Vec<SignalProgram> = programs.to_vec();
        programs.sort_by(|a, b| a.id.cmp(&b.id));
        let program_index: BTreeMap<String, u32> = programs
            .iter()
            .enumerate()
            .map(|(i, p)| (p.id.clone(), i as u32))
            .collect();
        let cycle_length: Vec<f64> = programs.iter().map(SignalProgram::cycle_s).collect();
        let mut controls: Vec<ControlEntry> = Vec::new();
        let mut coordination_ids: Vec<String> = Vec::new();
        let coordination_slot = |id: &str, coordination_ids: &mut Vec<String>| -> u32 {
            if let Some(i) = coordination_ids.iter().position(|c| c == id) {
                i as u32
            } else {
                coordination_ids.push(id.to_owned());
                (coordination_ids.len() - 1) as u32
            }
        };
        let mut stop_lines: Vec<StopLineBinding> = Vec::new();
        for (pi, p) in programs.iter().enumerate() {
            let control = ControlSlot(controls.len() as u32);
            controls.push(ControlEntry { id: p.id.clone() });
            let coordination_key = p
                .map_binding
                .as_ref()
                .map(|b| b.junction_id.as_str())
                .unwrap_or(p.id.as_str());
            let coordination = coordination_slot(coordination_key, &mut coordination_ids);
            for sl in &p.stop_lines {
                let Some(lane) = graph.lane_id(&sl.rsl) else {
                    continue;
                };
                let mut connecting: Vec<LaneId> = sl
                    .connecting_lane_rsls
                    .iter()
                    .filter_map(|r| graph.lane_id(r))
                    .collect();
                connecting.sort_unstable();
                // A movement filter naming only unknown lanes can never match a
                // route leg: keep the filter non-empty so it stays exclusive.
                if connecting.is_empty() && !sl.connecting_lane_rsls.is_empty() {
                    continue;
                }
                stop_lines.push(StopLineBinding {
                    control,
                    coordination,
                    kind: StopLineKind::Signal,
                    signal: Some(pi as u32),
                    dwell_s: 0.0,
                    lane,
                    s: sl.s,
                    connecting_lanes: connecting,
                });
            }
        }
        let mut sorted_controls: Vec<&RoadControl> = road_controls.iter().collect();
        // The reference orders static controls with `localeCompare` (programs
        // use plain code-unit `<`).
        sorted_controls.sort_by(|a, b| crate::hash::cmp_locale(&a.id, &b.id));
        for control_spec in sorted_controls {
            let control = ControlSlot(controls.len() as u32);
            controls.push(ControlEntry {
                id: control_spec.id.clone(),
            });
            let coordination_key = control_spec
                .map_binding
                .as_ref()
                .map(|b| b.junction_id.as_str())
                .unwrap_or(control_spec.id.as_str());
            let coordination = coordination_slot(coordination_key, &mut coordination_ids);
            for sl in &control_spec.stop_lines {
                let Some(lane) = graph.lane_id(&sl.rsl) else {
                    continue;
                };
                let mut connecting: Vec<LaneId> = sl
                    .connecting_lane_rsls
                    .iter()
                    .filter_map(|r| graph.lane_id(r))
                    .collect();
                connecting.sort_unstable();
                if connecting.is_empty() && !sl.connecting_lane_rsls.is_empty() {
                    continue;
                }
                stop_lines.push(StopLineBinding {
                    control,
                    coordination,
                    kind: StopLineKind::Stop,
                    signal: None,
                    dwell_s: control_spec.dwell_s,
                    lane,
                    s: sl.s,
                    connecting_lanes: connecting,
                });
            }
        }
        // Stable sort keeps per-control declaration order (already sorted by
        // (rsl, s) within each control) for equal (lane, s) keys.
        stop_lines.sort_by(|a, b| {
            a.lane
                .cmp(&b.lane)
                .then(a.s.partial_cmp(&b.s).unwrap_or(std::cmp::Ordering::Equal))
        });
        let mut lane_ranges: Vec<(LaneId, u32, u32)> = Vec::new();
        let mut i = 0;
        while i < stop_lines.len() {
            let lane = stop_lines[i].lane;
            let mut j = i + 1;
            while j < stop_lines.len() && stop_lines[j].lane == lane {
                j += 1;
            }
            lane_ranges.push((lane, i as u32, j as u32));
            i = j;
        }
        let overrides = vec![None; programs.len()];
        Self {
            programs,
            program_index,
            cycle_length,
            overrides,
            warmup_seconds,
            controls,
            coordination_ids,
            stop_lines,
            lane_ranges,
        }
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.stop_lines.is_empty() && self.programs.is_empty()
    }

    #[inline]
    pub fn programs(&self) -> &[SignalProgram] {
        &self.programs
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.programs.iter().map(|p| p.id.as_str())
    }

    #[inline]
    pub fn program_count(&self) -> usize {
        self.programs.len()
    }

    pub fn program_index(&self, signal_id: &str) -> Option<u32> {
        self.program_index.get(signal_id).copied()
    }

    pub fn program_id(&self, index: u32) -> &str {
        &self.programs[index as usize].id
    }

    #[inline]
    pub fn stop_lines(&self) -> &[StopLineBinding] {
        &self.stop_lines
    }

    pub fn control_id(&self, slot: ControlSlot) -> &str {
        &self.controls[slot.0 as usize].id
    }

    pub fn control_slot(&self, control_id: &str) -> Option<ControlSlot> {
        self.controls
            .iter()
            .position(|c| c.id == control_id)
            .map(|i| ControlSlot(i as u32))
    }

    pub fn coordination_id(&self, coordination: u32) -> &str {
        &self.coordination_ids[coordination as usize]
    }

    /// Stop lines on a lane, in storage-`s` order.
    pub fn on_lane(&self, lane: LaneId) -> &[StopLineBinding] {
        match self.lane_ranges.binary_search_by(|(l, _, _)| l.cmp(&lane)) {
            Ok(i) => {
                let (_, start, end) = self.lane_ranges[i];
                &self.stop_lines[start as usize..end as usize]
            }
            Err(_) => &[],
        }
    }

    /// Phase of program `index` at simulation time `t` (which may be negative).
    pub fn phase_at_index(&self, index: u32, t: f64) -> ControlIndication {
        self.state_at_index(index, t).phase
    }

    pub fn phase_at(&self, signal_id: &str, t: f64) -> Option<ControlIndication> {
        self.program_index(signal_id)
            .map(|i| self.phase_at_index(i, t))
    }

    pub fn state_at(&self, signal_id: &str, t: f64) -> Option<SignalState> {
        self.program_index(signal_id)
            .map(|i| self.state_at_index(i, t))
    }

    pub fn state_at_index(&self, index: u32, t: f64) -> SignalState {
        let p = &self.programs[index as usize];
        let timing_source = p
            .map_binding
            .as_ref()
            .map_or(TimingSource::Authored, |b| b.timing_source);
        if let Some(forced) = self.overrides[index as usize] {
            return SignalState {
                phase: forced,
                source: PhaseSource::Override,
                timing_source,
            };
        }
        let cycle = self.cycle_length[index as usize];
        let mut elapsed = t + self.warmup_seconds + p.offset_s;
        if p.loop_ {
            elapsed = ((elapsed % cycle) + cycle) % cycle;
        } else if elapsed < 0.0 {
            return SignalState {
                phase: p.phases[0].phase,
                source: PhaseSource::Program,
                timing_source,
            };
        } else if elapsed >= cycle {
            return SignalState {
                phase: p.phases[p.phases.len() - 1].phase,
                source: PhaseSource::Program,
                timing_source,
            };
        }
        let mut acc = 0.0;
        for ph in &p.phases {
            acc += ph.duration_s;
            if elapsed < acc {
                return SignalState {
                    phase: ph.phase,
                    source: PhaseSource::Program,
                    timing_source,
                };
            }
        }
        SignalState {
            phase: p.phases[p.phases.len() - 1].phase,
            source: PhaseSource::Program,
            timing_source,
        }
    }

    /// The full observable snapshot for `signal_id` at simulation time `t`,
    /// with timing boundaries denominated in engine ticks of `dt_s` seconds.
    pub fn snapshot_at(
        &self,
        signal_id: &str,
        t: f64,
        dt_s: Option<f64>,
    ) -> Option<SignalSnapshot> {
        let index = self.program_index(signal_id)?;
        let p = &self.programs[index as usize];
        let hz = 1.0 / dt_s.unwrap_or(1.0 / SIGNAL_SNAPSHOT_TICK_HZ);
        let cycle_s = self.cycle_length[index as usize];
        let mut head_ids: Vec<String> = match &p.map_binding {
            Some(b) => b.head_ids.clone(),
            None => p.stop_lines.iter().map(|sl| sl.rsl.clone()).collect(),
        };
        head_ids.sort();
        if p.map_binding.is_none() {
            head_ids.dedup();
        }
        let controller_id = p
            .map_binding
            .as_ref()
            .and_then(|b| b.controller_ids.first().cloned());
        let junction_id = p.map_binding.as_ref().map(|b| b.junction_id.clone());
        let timing_source = p
            .map_binding
            .as_ref()
            .map_or(TimingSource::Authored, |b| b.timing_source);
        let cycle_length_ticks = Some(js_round(cycle_s * hz) as i64);
        let base = |phase: ControlIndication, source: PhaseSource| SignalSnapshot {
            signal_id: signal_id.to_owned(),
            head_ids: head_ids.clone(),
            controller_id: controller_id.clone(),
            junction_id: junction_id.clone(),
            phase,
            source,
            timing_source,
            phase_start_tick: None,
            phase_end_tick: None,
            remaining_ticks: None,
            next_phase: None,
            cycle_length_ticks,
            failure_state: failure_state_of(phase),
        };
        if let Some(forced) = self.overrides[index as usize] {
            return Some(base(forced, PhaseSource::Override));
        }
        let elapsed_abs = t + self.warmup_seconds + p.offset_s;
        let mut idx = p.phases.len() - 1;
        let mut end_cyc_s = cycle_s;
        let mut clamped = false;
        if p.loop_ {
            let e = ((elapsed_abs % cycle_s) + cycle_s) % cycle_s;
            let mut acc = 0.0;
            for (i, ph) in p.phases.iter().enumerate() {
                acc += ph.duration_s;
                if e < acc {
                    idx = i;
                    end_cyc_s = acc;
                    break;
                }
            }
        } else if elapsed_abs < 0.0 || elapsed_abs >= cycle_s {
            clamped = true;
            idx = if elapsed_abs < 0.0 {
                0
            } else {
                p.phases.len() - 1
            };
        } else {
            let mut acc = 0.0;
            for (i, ph) in p.phases.iter().enumerate() {
                acc += ph.duration_s;
                if elapsed_abs < acc {
                    idx = i;
                    end_cyc_s = acc;
                    break;
                }
            }
        }
        let phase = p.phases[idx].phase;
        if clamped {
            return Some(base(phase, PhaseSource::Program));
        }
        let end_base_s = end_cyc_s - self.warmup_seconds - p.offset_s;
        let k = ((t - end_base_s) / cycle_s - SNAPSHOT_EPS_S).ceil();
        let phase_end_t = end_base_s + k * cycle_s;
        let phase_start_t = phase_end_t - p.phases[idx].duration_s;
        let next_phase = p.phases[(idx + 1) % p.phases.len()].phase;
        let phase_start_tick = js_round(phase_start_t * hz) as i64;
        let phase_end_tick = js_round(phase_end_t * hz) as i64;
        let mut snapshot = base(phase, PhaseSource::Program);
        snapshot.phase_start_tick = Some(phase_start_tick);
        snapshot.phase_end_tick = Some(phase_end_tick);
        snapshot.remaining_ticks = Some((phase_end_tick - js_round(t * hz) as i64).max(0));
        snapshot.next_phase = Some(next_phase);
        Some(snapshot)
    }

    /// Snapshots for every program, in sorted signal-id order.
    pub fn snapshots_at(&self, t: f64, dt_s: Option<f64>) -> Vec<SignalSnapshot> {
        self.programs
            .iter()
            .filter_map(|p| self.snapshot_at(&p.id, t, dt_s))
            .collect()
    }

    /// The law this stop line is executing at `t`.
    pub fn authority_at(&self, line: &StopLineBinding, t: f64) -> StopLineAuthority {
        if line.kind == StopLineKind::Stop {
            return StopLineAuthority {
                kind: AuthorityKind::Stop,
                dwell_s: line.dwell_s,
                reason: AuthorityReason::StaticStop,
            };
        }
        let Some(signal) = line.signal else {
            return StopLineAuthority {
                kind: AuthorityKind::Signal,
                dwell_s: 0.0,
                reason: AuthorityReason::Program,
            };
        };
        let program = &self.programs[signal as usize];
        let phase = self.phase_at_index(signal, t);
        let dwell_s = program.dark_dwell_s.unwrap_or(DEFAULT_DARK_DWELL_S);
        let fallback = program.dark_fallback.unwrap_or(DEFAULT_DARK_FALLBACK);
        match phase {
            ControlIndication::FlashingRed | ControlIndication::FlashingRedArrow => {
                StopLineAuthority {
                    kind: AuthorityKind::Stop,
                    dwell_s,
                    reason: AuthorityReason::FlashingRed,
                }
            }
            ControlIndication::Off => match fallback {
                // A yield keeps the ordinary conflict governor as the giving-way
                // mechanism; the line itself does not stop the actor.
                DarkFallback::Uncontrolled | DarkFallback::Yield => StopLineAuthority {
                    kind: AuthorityKind::None,
                    dwell_s: 0.0,
                    reason: AuthorityReason::BlackoutUncontrolled,
                },
                DarkFallback::AllWayStop => StopLineAuthority {
                    kind: AuthorityKind::Stop,
                    dwell_s,
                    reason: AuthorityReason::Blackout,
                },
            },
            _ => StopLineAuthority {
                kind: AuthorityKind::Signal,
                dwell_s: 0.0,
                reason: AuthorityReason::Program,
            },
        }
    }

    /// Force a world signal phase through `set(signal:<id>.phase, ...)`.
    pub fn set_override(&mut self, signal_id: &str, phase: Option<ControlIndication>) -> bool {
        match self.program_index(signal_id) {
            Some(i) => {
                self.overrides[i as usize] = phase;
                true
            }
            None => false,
        }
    }

    pub fn override_of(&self, index: u32) -> Option<ControlIndication> {
        self.overrides[index as usize]
    }

    /// Current overrides for checkpointing, in program order.
    pub fn overrides(&self) -> &[Option<ControlIndication>] {
        &self.overrides
    }

    pub fn restore_overrides(&mut self, overrides: &[Option<ControlIndication>]) {
        for (slot, value) in self.overrides.iter_mut().zip(overrides) {
            *slot = *value;
        }
    }
}

/// May an actor enter the intersection on this phase? Yellow is "stop if you
/// comfortably can", which the governor resolves with the comfort-decel test.
/// `off` is deliberately NOT permissive: a dark head degrades to `stop`
/// authority before this predicate is reached.
pub fn phase_forbids_entry(phase: ControlIndication) -> bool {
    !matches!(
        phase,
        ControlIndication::Green
            | ControlIndication::GreenArrow
            | ControlIndication::Proceed
            | ControlIndication::FlashingYellow
            | ControlIndication::FlashingYellowArrow
    )
}

/// Free-function form of [`SignalBook::snapshot_at`].
pub fn signal_snapshot_at(
    book: &SignalBook,
    signal_id: &str,
    t: f64,
    dt_s: Option<f64>,
) -> Option<SignalSnapshot> {
    book.snapshot_at(signal_id, t, dt_s)
}
