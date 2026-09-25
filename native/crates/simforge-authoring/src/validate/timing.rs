//! Static timing analysis: what the validator can know about *when* things
//! happen before anything has been simulated.
//!
//! A trigger resolves to one of three answers, kept distinct:
//! - exact: `at(3.5)`, or `after(x, 1)` where `x` is itself exact, or an
//!   expression over parameters at their declared defaults;
//! - window: `when(cond, byLatest: 12)` fires somewhere in `[clipStart, 12]`;
//! - unknown: an arrival solve, or an expression that reads a site fact,
//!   modelled as the widest window `[clipStart, clipEnd]`.
//!
//! Every rule built on this is written so that indeterminacy never produces
//! an error, at worst a warning.

use std::collections::{BTreeSet, HashMap};

use simforge_compiler::expr::{ExprScope, NumberOrExpr};
use simforge_compiler::template::{AfterEvent, Interaction, Trigger};
use simforge_core::hash::cmp_locale;

/// What the analyser managed to work out about a moment in time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TimeBound {
    Exact(f64),
    Window { earliest: f64, latest: f64 },
}

impl TimeBound {
    pub fn earliest(self) -> f64 {
        match self {
            Self::Exact(t) => t,
            Self::Window { earliest, .. } => earliest,
        }
    }

    pub fn latest(self) -> f64 {
        match self {
            Self::Exact(t) => t,
            Self::Window { latest, .. } => latest,
        }
    }
}

/// Inputs the analysis needs beyond the interactions themselves.
pub struct TimingContext<'a> {
    /// `-warmupSeconds`.
    pub clip_start: f64,
    /// `clipSeconds`.
    pub clip_end: f64,
    /// Parameters at their defaults, `clip.seconds`.
    pub scope: &'a ExprScope,
    /// Interactions by id (the last one wins, as a JavaScript `Map` built
    /// from the list does).
    pub by_id: HashMap<&'a str, &'a Interaction>,
}

impl TimingContext<'_> {
    fn full_window(&self) -> TimeBound {
        TimeBound::Window {
            earliest: self.clip_start,
            latest: self.clip_end,
        }
    }

    fn eval(&self, value: &NumberOrExpr) -> Option<f64> {
        value.evaluate(self.scope).ok()
    }
}

/// Resolve a trigger to a [`TimeBound`]. `visiting` guards `after` cycles: a
/// cyclic chain resolves to the full window (the cycle itself is reported by
/// the structural pass).
pub fn resolve_trigger_time(trigger: &Trigger, ctx: &TimingContext<'_>) -> TimeBound {
    resolve_visiting(trigger, ctx, &BTreeSet::new())
}

fn resolve_visiting(
    trigger: &Trigger,
    ctx: &TimingContext<'_>,
    visiting: &BTreeSet<String>,
) -> TimeBound {
    match trigger {
        Trigger::At { t } => match ctx.eval(t) {
            Some(t) => TimeBound::Exact(t),
            None => ctx.full_window(),
        },
        Trigger::When { by_latest, .. } => {
            let latest = by_latest.as_ref().and_then(|b| ctx.eval(b));
            TimeBound::Window {
                earliest: ctx.clip_start,
                latest: latest.unwrap_or(ctx.clip_end),
            }
        }
        Trigger::Arrival { .. } => ctx.full_window(),
        Trigger::After { of, event, delay_s } => {
            if visiting.contains(of) {
                return ctx.full_window();
            }
            let Some(target) = ctx.by_id.get(of.as_str()) else {
                return ctx.full_window();
            };
            let mut next = visiting.clone();
            next.insert(of.clone());
            let base = if *event == AfterEvent::End {
                end_bound(target, ctx, &next)
            } else {
                resolve_visiting(&target.base.trigger, ctx, &next)
            };
            let Some(delay) = ctx.eval(delay_s) else {
                return ctx.full_window();
            };
            match base {
                TimeBound::Exact(t) => TimeBound::Exact(t + delay),
                TimeBound::Window { earliest, latest } => TimeBound::Window {
                    earliest: earliest + delay,
                    latest: latest + delay,
                },
            }
        }
    }
}

/// When an interaction stops owning its axis by its own declaration.
fn end_bound(
    interaction: &Interaction,
    ctx: &TimingContext<'_>,
    visiting: &BTreeSet<String>,
) -> TimeBound {
    if let Some(until) = &interaction.base.until {
        return resolve_visiting(until, ctx, visiting);
    }
    let start = resolve_visiting(&interaction.base.trigger, ctx, visiting);
    TimeBound::Window {
        earliest: start.earliest(),
        latest: ctx.clip_end,
    }
}

/// One interaction's slot on an axis.
pub struct AxisSlot<'a> {
    pub interaction: &'a Interaction,
    /// Index in `choreography.interactions`, for the issue path.
    pub index: usize,
    pub start: TimeBound,
    /// Only present when the author wrote `until`.
    pub declared_end: Option<TimeBound>,
}

/// Every interaction owning one axis of one actor, in start order.
pub struct AxisTimeline<'a> {
    pub actor: &'a str,
    pub axis: String,
    pub slots: Vec<AxisSlot<'a>>,
}

/// Group interactions by `(actor, axis)` and sort each group by earliest
/// start (ties keep document order); the groups sort by actor then axis.
pub fn axis_timeline<'a>(
    interactions: &'a [Interaction],
    ctx: &TimingContext<'_>,
) -> Vec<AxisTimeline<'a>> {
    let mut groups: Vec<AxisTimeline<'a>> = Vec::new();
    for (index, interaction) in interactions.iter().enumerate() {
        let axis = interaction.verb.axis();
        let position = groups
            .iter()
            .position(|g| g.actor == interaction.base.actor && g.axis == axis);
        let group = match position {
            Some(i) => &mut groups[i],
            None => {
                groups.push(AxisTimeline {
                    actor: &interaction.base.actor,
                    axis,
                    slots: Vec::new(),
                });
                groups.last_mut().expect("just pushed")
            }
        };
        group.slots.push(AxisSlot {
            interaction,
            index,
            start: resolve_trigger_time(&interaction.base.trigger, ctx),
            declared_end: interaction
                .base
                .until
                .as_ref()
                .map(|u| resolve_trigger_time(u, ctx)),
        });
    }
    for group in &mut groups {
        group.slots.sort_by(|a, b| {
            let d = a.start.earliest() - b.start.earliest();
            d.partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.index.cmp(&b.index))
        });
    }
    groups.sort_by(|a, b| cmp_locale(a.actor, b.actor).then_with(|| cmp_locale(&a.axis, &b.axis)));
    groups
}
