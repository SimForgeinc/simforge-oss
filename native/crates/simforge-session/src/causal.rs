//! The causal ground-truth channel — the faithfulness-supervision contract.
//!
//! Per decision, the session records *why* the world changed in ways a camera
//! cannot show: LOS/occlusion transitions per observer per target, trigger
//! causality (fires and skips with the canonical-JSON summary of the authored
//! predicate, plus preemption/release/completion verbatim from the engine),
//! and conflict genesis (the first decision a monitored pair's running minimum
//! TTC or distance crosses its criticality threshold).
//!
//! The channel is versioned (`causalVersion: 1`) and canonical-JSON
//! serialisable alongside (never inside) a trace.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use simforge_core::engine::{ActorIndex, PairMinima};
use simforge_core::hash::{canonical_json_of, cmp_utf16};
use simforge_core::trace::events::SimEvent;
use simforge_core::types::Interaction;

use crate::observation::LosPair;

pub const CAUSAL_CHANNEL_VERSION: u32 = 1;

/// Default genesis thresholds.
pub const CONFLICT_GENESIS_TTC_S: f64 = 3.0;
pub const CONFLICT_GENESIS_DISTANCE_M: f64 = 5.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalLosTransition {
    pub observer_id: String,
    pub target_id: String,
    pub became_visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CausalTriggerKind {
    Completed,
    Fired,
    Preemption,
    Released,
    Skipped,
}

impl CausalTriggerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Fired => "fired",
            Self::Preemption => "preemption",
            Self::Released => "released",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalTriggerRecord {
    pub t_s: f64,
    pub kind: CausalTriggerKind,
    pub interaction_id: String,
    pub actor_id: String,
    /// Exact canonical-JSON summary of the authored predicate, for fired/skipped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forced: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenesisMetric {
    Distance,
    Ttc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalConflictGenesis {
    pub a: String,
    pub b: String,
    pub metric: GenesisMetric,
    /// Threshold whose first crossing this record is.
    pub threshold: f64,
    /// Running minimum value at the crossing decision.
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalFrame {
    pub t_s: f64,
    pub los_transitions: Vec<CausalLosTransition>,
    pub triggers: Vec<CausalTriggerRecord>,
    pub conflict_genesis: Vec<CausalConflictGenesis>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalChannel {
    pub causal_version: u32,
    pub ego_id: String,
    pub decision_hz: u32,
    pub frames: Vec<CausalFrame>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct PairGenesisState {
    ttc: bool,
    distance: bool,
}

/// Incremental collector. One instance per episode; feed it one decision's
/// events, minima and LOS pairs, in order. Serialisable for checkpoints.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalChannelCollector {
    ego_id: String,
    decision_hz: u32,
    frames: Vec<CausalFrame>,
    /// `(observer, target) -> visible`, keyed by actor handle.
    los_state: HashMap<(u32, u32), bool>,
    genesis: HashMap<(u32, u32), PairGenesisState>,
    /// Canonical trigger JSON per interaction id, computed once per episode.
    trigger_summaries: HashMap<String, String>,
}

fn key(a: ActorIndex, b: ActorIndex) -> (u32, u32) {
    (a.index() as u32, b.index() as u32)
}

impl CausalChannelCollector {
    pub fn new(ego_id: &str, decision_hz: u32, interactions: &[Interaction]) -> Self {
        let trigger_summaries = interactions
            .iter()
            .map(|it| {
                (
                    it.id.clone(),
                    canonical_json_of(&it.trigger).unwrap_or_else(|_| "external".to_owned()),
                )
            })
            .collect();
        Self {
            ego_id: ego_id.to_owned(),
            decision_hz,
            frames: Vec::new(),
            los_state: HashMap::new(),
            genesis: HashMap::new(),
            trigger_summaries,
        }
    }

    fn summarize(&self, interaction_id: &str) -> String {
        self.trigger_summaries
            .get(interaction_id)
            .cloned()
            .unwrap_or_else(|| "external".to_owned())
    }

    /// Record one decision. `ids` maps actor handles to canonical ids.
    pub fn observe<'a>(
        &mut self,
        t_s: f64,
        ids: impl Fn(ActorIndex) -> &'a str,
        los_pairs: &[LosPair],
        events: &[SimEvent],
        minima: &[PairMinima],
    ) {
        let mut los_transitions = Vec::new();
        for pair in los_pairs {
            let k = key(pair.observer, pair.target);
            let prev = self.los_state.get(&k).copied();
            if prev != Some(pair.visible) {
                self.los_state.insert(k, pair.visible);
                los_transitions.push(CausalLosTransition {
                    observer_id: ids(pair.observer).to_owned(),
                    target_id: ids(pair.target).to_owned(),
                    became_visible: pair.visible,
                });
            }
        }

        let mut triggers = Vec::new();
        for event in events {
            match event {
                SimEvent::TriggerFired {
                    t,
                    interaction_id,
                    actor_id,
                    forced,
                    ..
                } => triggers.push(CausalTriggerRecord {
                    t_s: *t,
                    kind: CausalTriggerKind::Fired,
                    interaction_id: interaction_id.clone(),
                    actor_id: actor_id.clone(),
                    forced: Some(*forced),
                    condition: Some(self.summarize(interaction_id)),
                    reason: None,
                }),
                SimEvent::TriggerSkipped {
                    t,
                    interaction_id,
                    actor_id,
                    reason,
                } => triggers.push(CausalTriggerRecord {
                    t_s: *t,
                    kind: CausalTriggerKind::Skipped,
                    interaction_id: interaction_id.clone(),
                    actor_id: actor_id.clone(),
                    reason: Some(reason.clone()),
                    condition: Some(self.summarize(interaction_id)),
                    forced: None,
                }),
                SimEvent::Preemption {
                    t,
                    actor_id,
                    by_interaction_id,
                    preempted_interaction_id,
                    ..
                } => triggers.push(CausalTriggerRecord {
                    t_s: *t,
                    kind: CausalTriggerKind::Preemption,
                    interaction_id: by_interaction_id.clone(),
                    actor_id: actor_id.clone(),
                    reason: Some(format!("preempts:{preempted_interaction_id}")),
                    condition: None,
                    forced: None,
                }),
                SimEvent::Released {
                    t,
                    actor_id,
                    interaction_id,
                    reason,
                    ..
                } => triggers.push(CausalTriggerRecord {
                    t_s: *t,
                    kind: CausalTriggerKind::Released,
                    interaction_id: interaction_id.clone(),
                    actor_id: actor_id.clone(),
                    reason: Some(reason.as_str().to_owned()),
                    condition: None,
                    forced: None,
                }),
                SimEvent::InteractionCompleted {
                    t,
                    actor_id,
                    interaction_id,
                    ..
                } => triggers.push(CausalTriggerRecord {
                    t_s: *t,
                    kind: CausalTriggerKind::Completed,
                    interaction_id: interaction_id.clone(),
                    actor_id: actor_id.clone(),
                    condition: None,
                    forced: None,
                    reason: None,
                }),
                _ => {}
            }
        }

        let mut conflict_genesis = Vec::new();
        for pair in minima {
            let state = self.genesis.entry(key(pair.a, pair.b)).or_default();
            if !state.ttc && pair.min_ttc_s.is_finite() && pair.min_ttc_s <= CONFLICT_GENESIS_TTC_S
            {
                state.ttc = true;
                conflict_genesis.push(CausalConflictGenesis {
                    a: ids(pair.a).to_owned(),
                    b: ids(pair.b).to_owned(),
                    metric: GenesisMetric::Ttc,
                    threshold: CONFLICT_GENESIS_TTC_S,
                    value: pair.min_ttc_s,
                });
            }
            if !state.distance
                && pair.min_distance_m.is_finite()
                && pair.min_distance_m <= CONFLICT_GENESIS_DISTANCE_M
            {
                state.distance = true;
                conflict_genesis.push(CausalConflictGenesis {
                    a: ids(pair.a).to_owned(),
                    b: ids(pair.b).to_owned(),
                    metric: GenesisMetric::Distance,
                    threshold: CONFLICT_GENESIS_DISTANCE_M,
                    value: pair.min_distance_m,
                });
            }
        }

        // Deterministic frame ordering regardless of map iteration order upstream.
        los_transitions.sort_by(|x, y| {
            cmp_utf16(&x.observer_id, &y.observer_id)
                .then_with(|| cmp_utf16(&x.target_id, &y.target_id))
        });
        triggers.sort_by(|x, y| {
            x.t_s
                .partial_cmp(&y.t_s)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| x.kind.as_str().cmp(y.kind.as_str()))
                .then_with(|| cmp_utf16(&x.interaction_id, &y.interaction_id))
                .then_with(|| cmp_utf16(&x.actor_id, &y.actor_id))
        });
        conflict_genesis.sort_by(|x, y| {
            cmp_utf16(&x.a, &y.a)
                .then_with(|| cmp_utf16(&x.b, &y.b))
                .then_with(|| x.metric.cmp(&y.metric))
        });
        self.frames.push(CausalFrame {
            t_s,
            los_transitions,
            triggers,
            conflict_genesis,
        });
    }

    /// The most recent decision's frame.
    #[inline]
    pub fn last_frame(&self) -> Option<&CausalFrame> {
        self.frames.last()
    }

    #[inline]
    pub fn frames(&self) -> &[CausalFrame] {
        &self.frames
    }

    pub fn channel(&self) -> CausalChannel {
        CausalChannel {
            causal_version: CAUSAL_CHANNEL_VERSION,
            ego_id: self.ego_id.clone(),
            decision_hz: self.decision_hz,
            frames: self.frames.clone(),
        }
    }
}

/// Canonical bytes for persistence alongside (never inside) a trace.
pub fn serialize_causal_channel(channel: &CausalChannel) -> simforge_core::Result<String> {
    canonical_json_of(channel)
}

/// Byte-exact round trip of [`serialize_causal_channel`].
pub fn parse_causal_channel(text: &str) -> serde_json::Result<CausalChannel> {
    serde_json::from_str(text)
}
