//! The tier-1 validator's map-dependent view of one matched site.
//!
//! The validator asks its questions in AnchorFrame coordinates `(k, s)`,
//! which is exactly what a matched site provides: the frame's reference path
//! turns `s` into a lane, its lateral lanes turn `k` into a parallel lane, and
//! everything else is a read of the bundle's derived index or the compiler's
//! site signal plan. No map fact is derived here; this only addresses the
//! bundle in frame coordinates. Every query is total: "no such thing here" is
//! `None`, never an error.

use std::cell::OnceCell;

use simforge_compiler::anchor::MatchedSite;
use simforge_compiler::map_index::{DerivedLane, DerivedMapIndex, LaneSideName};
use simforge_compiler::map_signals::{
    build_site_signal_plan, resolve_site_signal_program, SiteSignalPlan, SiteSignalRef,
};
use simforge_compiler::template::{ApproachRelation, TurnDirection};
use simforge_compiler::MapBundle;

const LANE_TYPES: [&str; 8] = [
    "driving",
    "shoulder",
    "sidewalk",
    "biking",
    "parking",
    "median",
    "restricted",
    "crosswalk",
];

/// What the validator needs to know about a lane.
#[derive(Debug, Clone, PartialEq)]
pub struct LaneFacts {
    /// A validator lane type (`other` for anything unlisted).
    pub lane_type: &'static str,
    pub k: i32,
    pub width_m: f64,
    /// Posted limit, kph; `None` when the map does not say.
    pub speed_limit_kph: Option<f64>,
}

/// Lane-marking permissions at a point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaneChangePermissions {
    pub left: bool,
    pub right: bool,
}

/// A signal head as the validator sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct SignalFacts {
    pub handle: String,
    /// Phases the program actually contains (first-seen order).
    pub phases: Vec<String>,
}

/// A site feature bound to a template feature id.
#[derive(Debug, Clone, PartialEq)]
pub struct FeatureFacts {
    pub at_m: f64,
    pub size_m: Option<f64>,
}

/// `MapContext` over one matched site on a loaded bundle.
pub struct SiteContext<'a> {
    bundle: &'a MapBundle,
    index: &'a DerivedMapIndex,
    site: &'a MatchedSite,
    plan: OnceCell<SiteSignalPlan>,
}

impl<'a> SiteContext<'a> {
    pub fn new(bundle: &'a MapBundle, site: &'a MatchedSite) -> Self {
        Self {
            bundle,
            index: bundle.index(),
            site,
            plan: OnceCell::new(),
        }
    }

    pub fn map_id(&self) -> &str {
        &self.index.map_id
    }

    fn lane_facts(&self, rsl: &str, k: i32, s: f64) -> Option<LaneFacts> {
        let lane = self.index.lanes.get(rsl)?;
        // The sample nearest `s` (the first one on a tie).
        let width = match lane.width_samples.first() {
            Some(first) => {
                lane.width_samples
                    .iter()
                    .fold(first, |best, sample| {
                        if (sample.s - s).abs() < (best.s - s).abs() {
                            sample
                        } else {
                            best
                        }
                    })
                    .width_m
            }
            None => lane.representative_width_m,
        };
        Some(LaneFacts {
            lane_type: LANE_TYPES
                .iter()
                .copied()
                .find(|t| *t == lane.lane_type)
                .unwrap_or("other"),
            k,
            width_m: width,
            speed_limit_kph: lane
                .speed_limit_kph
                .is_finite()
                .then_some(lane.speed_limit_kph),
        })
    }

    fn span_at(&self, s: f64) -> Option<&simforge_compiler::anchor::ReferenceSpan> {
        self.site
            .frame
            .reference_path
            .iter()
            .find(|sp| s >= sp.s_start && s <= sp.s_end)
    }

    fn lateral(&self, k: i32) -> Option<&str> {
        self.site.frame.lateral_lanes.get(&k).map(String::as_str)
    }

    /// The lane at frame position `(k, s)`, if one exists there.
    pub fn lane_at(&self, k: i32, s: f64) -> Option<LaneFacts> {
        if k == 0 {
            let span = self.span_at(s)?;
            return self.lane_facts(&span.lane_rsl, 0, s - span.s_start);
        }
        // A parallel lane's own arc length is not the frame's; the origin
        // cross-section is where `k` is defined, so width is read there.
        self.lane_facts(self.lateral(k)?, k, 0.0)
    }

    /// Lane-marking permissions at frame position `(k, s)`.
    pub fn lane_change_permissions(&self, k: i32, s: f64) -> LaneChangePermissions {
        let span = if k == 0 { self.span_at(s) } else { None };
        let rsl = if k == 0 {
            span.map(|sp| sp.lane_rsl.as_str())
        } else {
            self.lateral(k)
        };
        let Some(lane) = rsl.and_then(|r| self.index.lanes.get(r)) else {
            return LaneChangePermissions {
                left: false,
                right: false,
            };
        };
        let local = span.map_or(0.0, |sp| s - sp.s_start);
        let at = |side: LaneSideName| {
            let mut windows = lane
                .lane_change_permissions
                .iter()
                .filter(|p| p.side == side)
                .peekable();
            if windows.peek().is_none() {
                return !lane.is_junction;
            }
            windows.any(|p| local >= p.start_s && local <= p.end_s && p.allowed)
        };
        LaneChangePermissions {
            left: at(LaneSideName::Left),
            right: at(LaneSideName::Right),
        }
    }

    /// Whether the junction bound to `feature_id` has a movement entering
    /// from `from` (relative to the ego gate) and leaving via `turn`.
    pub fn gate(&self, feature_id: &str, from: &str, turn: TurnDirection) -> bool {
        let Some(junction_id) = self
            .site
            .feature_matches
            .get(feature_id)
            .and_then(|m| m.map_feature_id.strip_prefix("junction:"))
        else {
            return false;
        };
        let (Some(descriptor), Some(ego)) = (
            self.index.junction_descriptors.get(junction_id),
            self.site.frame.ego_gate_id.as_deref(),
        ) else {
            return false;
        };
        let gate = |id: &str| self.index.gates.iter().rev().find(|g| g.id == id);
        descriptor.conflict_pairs.iter().any(|pair| {
            if pair.gate_a != ego && pair.gate_b != ego {
                return false;
            }
            let other_id = if pair.gate_a == ego {
                &pair.gate_b
            } else {
                &pair.gate_a
            };
            let Some(other) = gate(other_id) else {
                return false;
            };
            if other.turn_relation != turn {
                return false;
            }
            let relation = if pair.gate_a == ego {
                pair.relation
            } else {
                match pair.relation {
                    ApproachRelation::FromLeft => ApproachRelation::FromRight,
                    ApproachRelation::FromRight => ApproachRelation::FromLeft,
                    other => other,
                }
            };
            relation.as_str() == from
        })
    }

    fn plan(&self) -> &SiteSignalPlan {
        self.plan
            .get_or_init(|| build_site_signal_plan(&self.bundle.signal_view(), self.site))
    }

    /// A signal by map handle, or by feature + approach.
    pub fn signal(&self, r#ref: SiteSignalRef<'_>) -> Option<SignalFacts> {
        let plan = self.plan();
        let handle =
            resolve_site_signal_program(&self.bundle.signal_view(), self.site, plan, &r#ref)?;
        let program = plan.programs.iter().find(|p| p.id == handle)?;
        let mut phases: Vec<String> = Vec::new();
        for phase in &program.phases {
            let name = phase_name(&phase.phase);
            if !phases.contains(&name) {
                phases.push(name);
            }
        }
        Some(SignalFacts { handle, phases })
    }

    /// A site feature bound to a template feature id.
    pub fn feature(&self, feature_id: &str) -> Option<FeatureFacts> {
        let m = self.site.feature_matches.get(feature_id)?;
        let size_m = m
            .map_feature_id
            .strip_prefix("junction:")
            .and_then(|j| self.index.junction_descriptors.get(j))
            .map(|d| d.size_m);
        Some(FeatureFacts { at_m: m.s, size_m })
    }

    /// Contiguous drivable metres from `(k, s)` in one direction.
    fn runway(&self, k: i32, s: f64, forward: bool) -> f64 {
        let frame = &self.site.frame;
        if k == 0 {
            return if forward {
                (frame.s_range.1 - s).max(0.0)
            } else {
                (s - frame.s_range.0).max(0.0)
            };
        }
        let Some(rsl) = self.lateral(k) else {
            return 0.0;
        };
        let lanes = &self.index.lanes;
        let length = |r: &str| lanes.get(r).map_or(0.0, |l: &DerivedLane| l.length_m);
        let mut total = length(rsl);
        let mut cursor = rsl.to_owned();
        let mut seen = vec![cursor.clone()];
        for _ in 0..32 {
            let Some(lane) = lanes.get(&cursor) else {
                break;
            };
            let links = if forward {
                &lane.successors
            } else {
                &lane.predecessors
            };
            let Some(next) = links.iter().find(|r| {
                !seen.contains(r)
                    && lanes
                        .get(r.as_str())
                        .is_some_and(|l| l.lane_type == "driving")
            }) else {
                break;
            };
            seen.push(next.clone());
            total += length(next);
            cursor = next.clone();
        }
        total
    }

    /// Drivable distance ahead of `(k, s)`: the whole-clip runway.
    pub fn forward_runway_m(&self, k: i32, s: f64) -> f64 {
        self.runway(k, s, true)
    }

    /// Drivable distance behind `(k, s)`: the warm-up run-up.
    pub fn upstream_runway_m(&self, k: i32, s: f64) -> f64 {
        self.runway(k, s, false)
    }
}

/// A program phase's indication, as the plan serialises it.
fn phase_name<T: serde::Serialize>(phase: &T) -> String {
    match serde_json::to_value(phase) {
        Ok(serde_json::Value::String(s)) => s,
        other => other.map(|v| v.to_string()).unwrap_or_default(),
    }
}
