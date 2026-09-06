//! Bare engine execution: whole-clip `run_simulation` and the explicit
//! actor-action `Simulation` handle (no episode/warmup/reward semantics; that
//! is [`super::Env`]'s job).

use simforge_core::engine::{
    run_simulation, ActionOverride, ActorAction, ActorIndex, ActorSnapshot, Simulation,
    SimulationCheckpoint, SimulationSnapshot,
};

use super::{decode_checkpoint, encode_checkpoint, Graph, Scenario};
use crate::action::{decode_action, ACTION_WIDTH};
use crate::error::{BindingError, Result};

/// The `t = 0` feasibility guards alone (`SimIssue[]` JSON), no clip run.
pub fn check_feasibility_json(scenario: &Scenario, graph: &Graph) -> Result<String> {
    Ok(serde_json::to_string(
        &simforge_core::solve::guards::check_feasibility(scenario.input(), graph.lane_graph()),
    )?)
}

/// `options_json` is the same override object [`Graph::run_options`] accepts.
/// Trace capture defaults on: the whole point of a batch run is its trace.
pub fn run_simulation_json(
    scenario: &Scenario,
    graph: &Graph,
    options_json: Option<&str>,
) -> Result<String> {
    let mut options = graph.run_options(options_json)?;
    if options_json.map_or(true, |t| !t.contains("captureTrace")) {
        options.capture_trace = true;
    }
    let result = run_simulation(scenario.input().clone(), options)?;
    Ok(serde_json::to_string(&result)?)
}

/// Per-actor snapshot row width: `[x, y, heading_rad, speed_mps, accel_mps2, lateral_offset_m, lateral_rate_mps, s]`.
pub const ACTOR_ROW: usize = 8;

/// Append one `ACTOR_ROW` row for `a` (xodr-local frame).
#[inline]
pub(crate) fn push_actor_row(rows: &mut Vec<f64>, a: &ActorSnapshot) {
    rows.extend_from_slice(&[
        a.x,
        a.y,
        a.heading_rad,
        a.speed_mps,
        a.accel_mps2,
        a.lateral_offset_m,
        a.lateral_rate_mps,
        a.s,
    ]);
}

/// One stepped world with explicit per-actor action batches.
pub struct Sim {
    sim: Simulation,
    graph: Graph,
    /// Run-option overrides this world was created with; restores reuse them.
    options_json: Option<String>,
    /// `SimResult` JSON once taken; the engine result is produced exactly once.
    result_json: Option<String>,
    actions: Vec<ActorAction>,
    snapshot: SimulationSnapshot,
    rows: Vec<f64>,
    present: Vec<bool>,
    lanes: Vec<Option<String>>,
}

impl Sim {
    pub fn new(scenario: &Scenario, graph: &Graph, options_json: Option<&str>) -> Result<Self> {
        let sim = Simulation::new(scenario.input().clone(), graph.run_options(options_json)?)?;
        let mut this = Self {
            sim,
            graph: graph.clone(),
            options_json: options_json.map(str::to_owned),
            result_json: None,
            actions: Vec::new(),
            snapshot: SimulationSnapshot::default(),
            rows: Vec::new(),
            present: Vec::new(),
            lanes: Vec::new(),
        };
        this.refresh();
        Ok(this)
    }

    pub fn t_s(&self) -> f64 {
        self.sim.t_s()
    }
    pub fn dt_s(&self) -> f64 {
        self.sim.dt_s()
    }
    pub fn tick_index(&self) -> u64 {
        self.sim.tick_index()
    }
    pub fn done(&self) -> bool {
        self.snapshot.done
    }
    pub fn actor_count(&self) -> usize {
        self.sim.actor_count()
    }
    /// Canonical ids in actor-index order (stable for the simulation's lifetime).
    pub fn actor_ids(&self) -> Vec<String> {
        (0..self.sim.actor_count())
            .map(|i| self.sim.actor_id(ActorIndex(i as u32)).to_owned())
            .collect()
    }
    pub fn actor_index(&self, id: &str) -> Result<usize> {
        self.sim
            .actor_index(id)
            .map(|i| i.index())
            .ok_or_else(|| BindingError::argument(format!("unknown actor {id}")))
    }
    pub fn actor_kinds(&self) -> Vec<&'static str> {
        (0..self.sim.actor_count())
            .map(|i| self.sim.actor_kind(ActorIndex(i as u32)).as_str())
            .collect()
    }
    /// `(N, 3)` `[l, w, h]` in actor-index order.
    pub fn actor_dims(&self) -> Vec<f64> {
        (0..self.sim.actor_count())
            .flat_map(|i| {
                let d = self.sim.actor_dims(ActorIndex(i as u32));
                [d.l, d.w, d.h]
            })
            .collect()
    }

    /// Advance up to `max_ticks` holding `actions`: `(K, 1 + ACTION_WIDTH)`
    /// rows `[actor_index, ...flat action]`. Returns `(ticks_advanced, done)`.
    pub fn advance(&mut self, max_ticks: usize, actions: &[f64]) -> Result<(usize, bool)> {
        const ROW: usize = 1 + ACTION_WIDTH;
        if actions.len() % ROW != 0 {
            return Err(BindingError::argument(format!(
                "actions must be (K, {ROW}) row-major, got {} values",
                actions.len()
            )));
        }
        self.actions.clear();
        let count = self.sim.actor_count();
        for row in actions.chunks_exact(ROW) {
            let index = row[0];
            if !(index.is_finite()
                && index >= 0.0
                && index.fract() == 0.0
                && (index as usize) < count)
            {
                return Err(BindingError::argument(format!(
                    "actor index {index} out of range (world has {count} actors)"
                )));
            }
            let action: ActionOverride = decode_action(&row[1..])?;
            self.actions.push(ActorAction {
                actor: ActorIndex(index as u32),
                action,
            });
        }
        let progress = self.sim.advance(max_ticks, &self.actions)?;
        self.refresh();
        Ok((progress.ticks_advanced, progress.done))
    }

    /// `(N, ACTOR_ROW)` rows in actor-index order (xodr-local frame).
    pub fn actor_rows(&self) -> &[f64] {
        &self.rows
    }
    pub fn present(&self) -> &[bool] {
        &self.present
    }
    pub fn lane_rsls(&self) -> &[Option<String>] {
        &self.lanes
    }
    /// Running pair minima as JSON `[{a, b, minDistanceM, minTtcS, minPathTtcS, minPetS}]`.
    pub fn minima_json(&self) -> Result<String> {
        let rows: Vec<serde_json::Value> = self
            .snapshot
            .minima
            .iter()
            .map(|m| {
                serde_json::json!({
                    "a": self.sim.actor_id(m.a), "b": self.sim.actor_id(m.b),
                    "minDistanceM": m.min_distance_m, "minTtcS": m.min_ttc_s, "minPathTtcS": m.min_path_ttc_s, "minPetS": m.min_pet_s,
                })
            })
            .collect();
        Ok(serde_json::to_string(&rows)?)
    }
    /// Events recorded since the previous drain, as JSON `SimEvent[]`.
    pub fn drain_events_json(&mut self) -> Result<String> {
        Ok(serde_json::to_string(&self.sim.drain_events())?)
    }

    pub fn checkpoint(&self) -> Result<Vec<u8>> {
        encode_checkpoint(&self.sim.checkpoint()?)
    }
    pub fn restore(&mut self, bytes: &[u8]) -> Result<()> {
        let checkpoint: SimulationCheckpoint = decode_checkpoint(bytes)?;
        self.sim = Simulation::restore(
            &checkpoint,
            self.graph.run_options(self.options_json.as_deref())?,
        )?;
        self.result_json = None;
        self.refresh();
        Ok(())
    }
    /// Trace recorded so far; does not advance, finalize or drain the world.
    pub fn trace_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.sim.build_trace()?)?)
    }
    /// The exact resolved input used by this world.
    pub fn input_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self.sim.input())?)
    }
    pub fn issues_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self.sim.issues())?)
    }
    pub fn arrival_json(&self) -> Result<String> {
        Ok(serde_json::to_string(self.sim.arrival_solutions())?)
    }
    /// The completed run's `SimResult` JSON (`{input, trace, issues, arrival}`).
    /// Errors (engine kind) until `done`; the engine result is taken once and
    /// the handle stays readable (snapshot/actors) afterwards.
    pub fn result_json(&mut self) -> Result<String> {
        if let Some(json) = &self.result_json {
            return Ok(json.clone());
        }
        if !self.sim.done() {
            return Err(self.sim_not_done());
        }
        // `into_result` consumes the engine; keep a restored twin for reads.
        let checkpoint = self.sim.checkpoint()?;
        let twin = Simulation::restore(
            &checkpoint,
            self.graph.run_options(self.options_json.as_deref())?,
        )?;
        let finished = std::mem::replace(&mut self.sim, twin);
        let json = serde_json::to_string(&finished.into_result()?)?;
        self.result_json = Some(json.clone());
        Ok(json)
    }
    fn sim_not_done(&self) -> BindingError {
        // Same failure the engine itself reports from `into_result`.
        BindingError::Engine(simforge_core::error::SimEngineError::new(
            "simulation has not completed; advance until done",
            Vec::new(),
        ))
    }
    /// Signal state at the current instant: `{tS, signals, overrides}`.
    pub fn signal_state_json(&self) -> Result<String> {
        super::env::signal_state_json(&self.sim)
    }

    fn refresh(&mut self) {
        self.sim.peek_into(&mut self.snapshot);
        self.rows.clear();
        self.present.clear();
        self.lanes.clear();
        for a in &self.snapshot.actors {
            push_actor_row(&mut self.rows, a);
            self.present.push(a.present);
            self.lanes
                .push(a.lane.map(|l| self.graph.lane_graph().rsl(l).to_owned()));
        }
    }
}
