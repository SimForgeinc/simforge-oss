//! Command-driven live/clip world.
//!
//! Commands, outcomes, logs and truth frames are typed upstream; they cross
//! the FFI as JSON because they are per-command / per-tick *metadata*, not the
//! hot batched stepping path. The actor snapshot is exposed as flat rows.

use std::sync::Arc;

use simforge_core::physics::VehicleControl;
use simforge_session::{
    replay_world_session_log, TruthFrame, TruthSubscription, WorldCheckpoint, WorldCommand,
    WorldMode, WorldSession, WorldSessionLog, WorldSessionOptions, WorldSnapshot,
};

use super::{decode_checkpoint, encode_checkpoint, Graph, Scenario};
use crate::error::{BindingError, Result};

/// Flat rows of a world snapshot, in snapshot actor order.
pub struct WorldSnapshotView {
    snapshot: WorldSnapshot,
    /// `(N, 5)`: `[x, z, heading_rad, speed_mps, s]` scene frame.
    pose: Vec<f64>,
    present: Vec<bool>,
}

impl WorldSnapshotView {
    fn new(snapshot: WorldSnapshot) -> Self {
        let mut pose = Vec::with_capacity(snapshot.actors.len() * 5);
        let mut present = Vec::with_capacity(snapshot.actors.len());
        for a in &snapshot.actors {
            pose.extend_from_slice(&[a.x, a.z, a.heading_rad, a.speed_mps, a.s]);
            present.push(a.present);
        }
        Self {
            snapshot,
            pose,
            present,
        }
    }
    pub fn t_s(&self) -> f64 {
        self.snapshot.t_s
    }
    pub fn tick(&self) -> usize {
        self.snapshot.tick
    }
    pub fn done(&self) -> bool {
        self.snapshot.done
    }
    pub fn actor_ids(&self) -> Vec<String> {
        self.snapshot.actors.iter().map(|a| a.id.clone()).collect()
    }
    pub fn kinds(&self) -> Vec<&'static str> {
        self.snapshot
            .actors
            .iter()
            .map(|a| a.kind.as_str())
            .collect()
    }
    pub fn lane_rsls(&self) -> Vec<Option<String>> {
        self.snapshot
            .actors
            .iter()
            .map(|a| a.lane_rsl.clone())
            .collect()
    }
    pub fn pose(&self) -> &[f64] {
        &self.pose
    }
    pub fn present(&self) -> &[bool] {
        &self.present
    }
    pub fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.snapshot)?)
    }
}

/// Pull-based truth subscriber handle.
pub struct TruthSubscriber {
    subscription: TruthSubscription,
    scratch: Vec<Arc<TruthFrame>>,
}

impl TruthSubscriber {
    /// Every queued frame, oldest first, as JSON documents.
    pub fn drain_json(&mut self) -> Result<Vec<String>> {
        self.scratch.clear();
        self.subscription.drain_into(&mut self.scratch);
        self.scratch
            .iter()
            .map(|f| serde_json::to_string(&**f).map_err(Into::into))
            .collect()
    }
    /// Every queued frame as the frozen truth-stream wire framing:
    /// `u32le byte_length || msgpack(TruthFrame)`. Byte identity is engine-owned;
    /// hosts forward frames without re-encoding.
    pub fn drain_framed(&mut self) -> Result<Vec<Vec<u8>>> {
        self.scratch.clear();
        self.subscription.drain_into(&mut self.scratch);
        self.scratch
            .iter()
            .map(|f| {
                let body = rmp_serde::to_vec_named(&**f)
                    .map_err(|e| BindingError::runtime(format!("truth frame encode: {e}")))?;
                let mut out = Vec::with_capacity(4 + body.len());
                out.extend_from_slice(&(body.len() as u32).to_le_bytes());
                out.extend_from_slice(&body);
                Ok(out)
            })
            .collect()
    }
    pub fn dropped(&self) -> u64 {
        self.subscription.stats().dropped
    }
    pub fn queued(&self) -> usize {
        self.subscription.stats().queued
    }
    pub fn is_active(&self) -> bool {
        self.subscription.is_active()
    }
    pub fn close(&self) {
        self.subscription.unsubscribe();
    }
}

pub struct World {
    session: WorldSession,
    graph: Graph,
}

fn parse_mode(name: Option<&str>) -> Result<WorldMode> {
    match name {
        None | Some("clip") => Ok(WorldMode::Clip),
        Some("live") => Ok(WorldMode::Live),
        Some(other) => Err(BindingError::argument(format!(
            "unknown world mode {other:?}; expected clip or live"
        ))),
    }
}

impl World {
    /// `options_json`: `{mode?: "clip"|"live", horizonSeconds?}`.
    pub fn new(scenario: &Scenario, graph: &Graph, options_json: Option<&str>) -> Result<Self> {
        #[derive(Default, serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Options {
            mode: Option<String>,
            horizon_seconds: Option<f64>,
        }
        let o: Options = match options_json {
            None => Options::default(),
            Some(text) => serde_json::from_str(text)
                .map_err(|e| BindingError::argument(format!("world options: {e}")))?,
        };
        let session = WorldSession::new(
            scenario.input().clone(),
            WorldSessionOptions {
                run_options: graph.run_options(None)?,
                horizon_seconds: o.horizon_seconds,
                mode: parse_mode(o.mode.as_deref())?,
            },
        )?;
        Ok(Self {
            session,
            graph: graph.clone(),
        })
    }

    pub fn time(&self) -> f64 {
        self.session.time()
    }
    pub fn tick(&self) -> usize {
        self.session.tick()
    }
    pub fn digest(&self) -> &str {
        self.session.digest()
    }

    /// Apply one `WorldCommand` JSON for `client_id`/`seq`; returns `CommandOutcome` JSON.
    pub fn command_json(
        &mut self,
        client_id: &str,
        seq: u64,
        command_json: &str,
    ) -> Result<String> {
        let command: WorldCommand = serde_json::from_str(command_json)
            .map_err(|e| BindingError::argument(format!("world command: {e}")))?;
        let outcome = self.session.apply_command(client_id, seq, &command)?;
        Ok(serde_json::to_string(&outcome)?)
    }

    /// Hold one actor's pedals and wheel until replaced; `None` releases the
    /// actor back to its scenario controller.
    ///
    /// Typed rather than JSON because a driver client calls this on every
    /// render frame, and parsing a command document 60 times a second to
    /// carry four numbers is pure overhead.
    pub fn set_driver_command(
        &mut self,
        client_id: &str,
        seq: u64,
        actor_id: &str,
        command: Option<VehicleControl>,
    ) -> Result<String> {
        if let Some(c) = command {
            if !(0.0..=1.0).contains(&c.throttle)
                || !(0.0..=1.0).contains(&c.brake)
                || !(-1.0..=1.0).contains(&c.steer)
            {
                return Err(BindingError::argument(format!(
                    "driver command out of range: throttle {} and brake {} must be in [0, 1], steer {} in [-1, 1]",
                    c.throttle, c.brake, c.steer
                ))
                .into());
            }
        }
        let outcome = self
            .session
            .set_driver_command(client_id, seq, actor_id, command)?;
        Ok(serde_json::to_string(&outcome)?)
    }

    /// Advance `ticks` engine ticks; returns `AdvanceResult` JSON.
    pub fn advance_json(&mut self, ticks: usize) -> Result<String> {
        Ok(serde_json::to_string(&self.session.advance(ticks)?)?)
    }

    pub fn snapshot(&mut self) -> WorldSnapshotView {
        WorldSnapshotView::new(self.session.snapshot())
    }

    pub fn subscribe(&mut self, capacity: Option<usize>) -> Result<TruthSubscriber> {
        Ok(TruthSubscriber {
            subscription: self.session.subscribe_truth(capacity)?,
            scratch: Vec::new(),
        })
    }

    pub fn log_json(&self) -> Result<String> {
        Ok(serde_json::to_string(&self.session.export_log())?)
    }

    pub fn checkpoint(&self) -> Result<Vec<u8>> {
        encode_checkpoint(&self.session.checkpoint()?)
    }

    /// Replace this world with the checkpointed one (same graph). Truth
    /// subscribers are not carried; re-subscribe after restoring.
    pub fn restore(&mut self, bytes: &[u8]) -> Result<()> {
        let checkpoint: WorldCheckpoint = decode_checkpoint(bytes)?;
        self.session = WorldSession::restore(&checkpoint, self.graph.run_options(None)?)?;
        Ok(())
    }
}

/// Replay a `WorldSessionLog` JSON over `scenario`/`graph`; returns `ReplayResult` JSON.
pub fn replay_world_log_json(log_json: &str, scenario: &Scenario, graph: &Graph) -> Result<String> {
    let log: WorldSessionLog = serde_json::from_str(log_json)
        .map_err(|e| BindingError::argument(format!("world session log: {e}")))?;
    let result =
        replay_world_session_log(&log, scenario.input().clone(), graph.run_options(None)?)?;
    Ok(serde_json::to_string(&result)?)
}
