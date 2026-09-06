//! Physical signal control: exact reverse indices from executable programs and
//! their preserved OpenDRIVE controller-stage metadata, plus the compiler
//! that turns bounded authoring clips (`mapSignalPlans`) into complete,
//! non-looping engine programs.
//!
//! A plan binds by immutable map id plus exact junction, controller and head
//! ids, and every one of those is checked. It deliberately does NOT bind to a
//! broad hash of the map's control closure: unrelated road-control enrichment
//! (a stop line on another arm, a parking bay) must not invalidate a signal
//! plan that still names live heads. No geometric/proximity inference occurs.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use simforge_core::types::{ControlIndication, SignalPhase, SignalProgram, TimingSource};

use crate::error::CompileError;
use crate::map_signals::MapSignalCatalog;
use crate::template::{MapSignalPlan, MapSignalPlanClip};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalControlDiagnosticCode {
    UnresolvedHead,
    UnresolvedMovement,
    SharedHead,
    ConflictingControllerStage,
    MissingControllerStage,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalControlDiagnostic {
    pub code: SignalControlDiagnosticCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub head_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub movement_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controller_ids: Vec<String>,
}

/// The executable movement grain. One program may govern several
/// approach/connecting-lane pairs, but it has one phase at `t`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalMovementBinding {
    pub id: String,
    pub program_id: String,
    pub junction_id: String,
    pub controller_ids: Vec<String>,
    pub head_ids: Vec<String>,
    pub approach_lane_rsls: Vec<String>,
    pub connecting_lane_rsls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalControllerBinding {
    pub id: String,
    pub junction_id: String,
    pub head_ids: Vec<String>,
    pub movement_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalHeadControlBinding {
    pub id: String,
    pub junction_ids: Vec<String>,
    pub controller_ids: Vec<String>,
    pub movement_ids: Vec<String>,
    /// False means the physical head exists but no exact program/controller owns it.
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalJunctionControlBinding {
    pub id: String,
    pub controller_ids: Vec<String>,
    pub movement_ids: Vec<String>,
    pub head_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalControlIndex {
    pub heads: BTreeMap<String, SignalHeadControlBinding>,
    pub movements: BTreeMap<String, SignalMovementBinding>,
    pub controllers: BTreeMap<String, SignalControllerBinding>,
    pub junctions: BTreeMap<String, SignalJunctionControlBinding>,
    pub diagnostics: Vec<SignalControlDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalReferenceSelection {
    pub selected_head_id: String,
    pub reference_movement_id: String,
    /// Exact authoritative OpenDRIVE controller stage selected for authoring.
    pub reference_controller_id: String,
    pub junction_id: String,
    pub controller_ids: Vec<String>,
    pub stage_movement_ids: Vec<String>,
    pub movement_head_ids: Vec<String>,
    pub intersection_head_ids: Vec<String>,
    pub related_movement_ids: Vec<String>,
    pub diagnostics: Vec<SignalControlDiagnostic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignalReferenceEvaluation {
    pub time_seconds: f64,
    pub head_states: BTreeMap<String, ControlIndication>,
    pub movement_states: BTreeMap<String, ControlIndication>,
    pub diagnostics: Vec<SignalControlDiagnostic>,
}

fn sorted_unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn add(
    map: &mut BTreeMap<String, BTreeSet<String>>,
    key: &str,
    values: impl IntoIterator<Item = String>,
) {
    map.entry(key.to_owned()).or_default().extend(values);
}

fn take(map: &BTreeMap<String, BTreeSet<String>>, key: &str) -> Vec<String> {
    map.get(key)
        .map(|s| s.iter().cloned().collect())
        .unwrap_or_default()
}

/// Build exact reverse indices from executable programs and their preserved
/// OpenDRIVE controller-stage metadata.
pub fn build_signal_control_index(
    programs: &[SignalProgram],
    physical_head_ids: &[String],
) -> SignalControlIndex {
    let mut diagnostics = Vec::new();
    let mut movements: BTreeMap<String, SignalMovementBinding> = BTreeMap::new();
    let mut heads_to_movements = BTreeMap::new();
    let mut heads_to_controllers = BTreeMap::new();
    let mut heads_to_junctions = BTreeMap::new();
    let mut controller_heads = BTreeMap::new();
    let mut controller_movements = BTreeMap::new();
    let mut controller_junction: BTreeMap<String, String> = BTreeMap::new();
    let mut junction_heads = BTreeMap::new();
    let mut junction_controllers = BTreeMap::new();
    let mut junction_movements = BTreeMap::new();

    let mut ordered: Vec<&SignalProgram> = programs.iter().collect();
    ordered.sort_by(|a, b| a.id.cmp(&b.id));
    for program in ordered {
        let Some(binding) = &program.map_binding else {
            diagnostics.push(SignalControlDiagnostic {
                code: SignalControlDiagnosticCode::UnresolvedMovement,
                message: format!(
                    "Signal movement {} has no physical map binding.",
                    program.id
                ),
                head_ids: Vec::new(),
                movement_ids: vec![program.id.clone()],
                controller_ids: Vec::new(),
            });
            continue;
        };
        let head_ids = sorted_unique(binding.head_ids.iter().cloned());
        let controller_ids = sorted_unique(binding.controller_ids.iter().cloned());
        if binding.controller_head_groups.is_none() {
            diagnostics.push(SignalControlDiagnostic {
                code: SignalControlDiagnosticCode::MissingControllerStage,
                message: format!(
                    "Signal movement {} lacks exact controller-stage membership.",
                    program.id
                ),
                head_ids: Vec::new(),
                movement_ids: vec![program.id.clone()],
                controller_ids: controller_ids.clone(),
            });
        }
        let movement = SignalMovementBinding {
            id: program.id.clone(),
            program_id: program.id.clone(),
            junction_id: binding.junction_id.clone(),
            controller_ids: controller_ids.clone(),
            head_ids: head_ids.clone(),
            approach_lane_rsls: sorted_unique(program.stop_lines.iter().map(|l| l.rsl.clone())),
            connecting_lane_rsls: sorted_unique(
                program
                    .stop_lines
                    .iter()
                    .flat_map(|l| l.connecting_lane_rsls.iter().cloned()),
            ),
        };
        add(
            &mut junction_heads,
            &movement.junction_id,
            head_ids.iter().cloned(),
        );
        add(
            &mut junction_controllers,
            &movement.junction_id,
            controller_ids.iter().cloned(),
        );
        add(
            &mut junction_movements,
            &movement.junction_id,
            [movement.id.clone()],
        );
        for head_id in &head_ids {
            add(&mut heads_to_movements, head_id, [movement.id.clone()]);
            add(
                &mut heads_to_controllers,
                head_id,
                controller_ids.iter().cloned(),
            );
            add(
                &mut heads_to_junctions,
                head_id,
                [movement.junction_id.clone()],
            );
        }
        let groups: Vec<(String, Vec<String>)> = match &binding.controller_head_groups {
            Some(groups) => groups
                .iter()
                .map(|g| (g.controller_id.clone(), g.head_ids.clone()))
                .collect(),
            None => controller_ids
                .iter()
                .map(|c| (c.clone(), head_ids.clone()))
                .collect(),
        };
        for (controller_id, group_heads) in groups {
            add(
                &mut controller_heads,
                &controller_id,
                group_heads.iter().cloned(),
            );
            add(
                &mut controller_movements,
                &controller_id,
                [movement.id.clone()],
            );
            controller_junction.insert(controller_id.clone(), movement.junction_id.clone());
            for head_id in &group_heads {
                add(&mut heads_to_controllers, head_id, [controller_id.clone()]);
                add(
                    &mut heads_to_junctions,
                    head_id,
                    [movement.junction_id.clone()],
                );
            }
        }
        movements.insert(movement.id.clone(), movement);
    }

    let all_head_ids = sorted_unique(
        physical_head_ids
            .iter()
            .cloned()
            .chain(heads_to_movements.keys().cloned())
            .chain(heads_to_controllers.keys().cloned()),
    );
    let mut heads = BTreeMap::new();
    for id in all_head_ids {
        let movement_ids = take(&heads_to_movements, &id);
        let resolved = !movement_ids.is_empty();
        if !resolved {
            diagnostics.push(SignalControlDiagnostic {
                code: SignalControlDiagnosticCode::UnresolvedHead,
                message: format!(
                    "Physical signal head {id} has no exact movement/controller binding."
                ),
                head_ids: vec![id.clone()],
                movement_ids: Vec::new(),
                controller_ids: Vec::new(),
            });
        }
        if movement_ids.len() > 1 {
            diagnostics.push(SignalControlDiagnostic {
                code: SignalControlDiagnosticCode::SharedHead,
                message: format!(
                    "Physical signal head {id} is shared by {} movements.",
                    movement_ids.len()
                ),
                head_ids: vec![id.clone()],
                movement_ids: movement_ids.clone(),
                controller_ids: Vec::new(),
            });
        }
        heads.insert(
            id.clone(),
            SignalHeadControlBinding {
                id: id.clone(),
                junction_ids: take(&heads_to_junctions, &id),
                controller_ids: take(&heads_to_controllers, &id),
                movement_ids,
                resolved,
            },
        );
    }

    let controllers = controller_heads
        .keys()
        .map(|id| {
            (
                id.clone(),
                SignalControllerBinding {
                    id: id.clone(),
                    junction_id: controller_junction.get(id).cloned().unwrap_or_default(),
                    head_ids: take(&controller_heads, id),
                    movement_ids: take(&controller_movements, id),
                },
            )
        })
        .collect();
    let junctions = junction_movements
        .keys()
        .map(|id| {
            (
                id.clone(),
                SignalJunctionControlBinding {
                    id: id.clone(),
                    controller_ids: take(&junction_controllers, id),
                    movement_ids: take(&junction_movements, id),
                    head_ids: take(&junction_heads, id),
                },
            )
        })
        .collect();
    SignalControlIndex {
        heads,
        movements,
        controllers,
        junctions,
        diagnostics,
    }
}

/// Resolve a physical head into a deterministic reference movement and all
/// related scopes.
pub fn select_signal_reference(
    index: &SignalControlIndex,
    head_id: &str,
    preferred_movement_id: Option<&str>,
    preferred_controller_id: Option<&str>,
) -> Option<SignalReferenceSelection> {
    let head = index.heads.get(head_id)?;
    if !head.resolved {
        return None;
    }
    let reference_movement_id = match preferred_movement_id {
        Some(p) if head.movement_ids.iter().any(|m| m == p) => p.to_owned(),
        _ => head.movement_ids.first()?.clone(),
    };
    let movement = index.movements.get(&reference_movement_id)?;
    let eligible: Vec<&String> = movement
        .controller_ids
        .iter()
        .filter(|c| {
            index
                .controllers
                .get(*c)
                .is_some_and(|ctl| ctl.head_ids.iter().any(|h| h == head_id))
        })
        .collect();
    if let Some(preferred) = preferred_controller_id {
        if !eligible.iter().any(|c| *c == preferred) {
            return None;
        }
    }
    let reference_controller_id = preferred_controller_id
        .map(str::to_owned)
        .or_else(|| eligible.first().map(|c| (*c).clone()))?;
    let controller = index.controllers.get(&reference_controller_id)?;
    if controller.junction_id != movement.junction_id
        || !controller.head_ids.iter().any(|h| h == head_id)
    {
        return None;
    }
    let junction = index.junctions.get(&movement.junction_id);
    let intersection_head_ids = junction
        .map(|j| j.head_ids.clone())
        .unwrap_or_else(|| movement.head_ids.clone());
    let related_movement_ids = junction
        .map(|j| j.movement_ids.clone())
        .unwrap_or_else(|| vec![movement.id.clone()]);
    let diagnostics = index
        .diagnostics
        .iter()
        .filter(|d| {
            matches!(
                d.code,
                SignalControlDiagnosticCode::UnresolvedHead
                    | SignalControlDiagnosticCode::UnresolvedMovement
                    | SignalControlDiagnosticCode::SharedHead
                    | SignalControlDiagnosticCode::MissingControllerStage
            ) && (d.head_ids.iter().any(|h| intersection_head_ids.contains(h))
                || d.movement_ids
                    .iter()
                    .any(|m| related_movement_ids.contains(m)))
        })
        .cloned()
        .collect();
    Some(SignalReferenceSelection {
        selected_head_id: head_id.to_owned(),
        reference_movement_id,
        reference_controller_id,
        junction_id: movement.junction_id.clone(),
        controller_ids: movement.controller_ids.clone(),
        stage_movement_ids: controller.movement_ids.clone(),
        movement_head_ids: controller.head_ids.clone(),
        intersection_head_ids,
        related_movement_ids,
        diagnostics,
    })
}

/// Project authored movement state onto every physical head at the selected
/// intersection. Exact controller-stage head membership is authoritative.
pub fn evaluate_signal_reference_phase(
    index: &SignalControlIndex,
    selection: &SignalReferenceSelection,
    time_seconds: f64,
    reference_phase: ControlIndication,
    movement_phases: &BTreeMap<String, ControlIndication>,
) -> SignalReferenceEvaluation {
    let mut diagnostics = selection.diagnostics.clone();
    let sibling_phase = match reference_phase {
        ControlIndication::FlashingRed | ControlIndication::FlashingYellow => {
            ControlIndication::FlashingRed
        }
        _ => ControlIndication::Red,
    };
    let reference_is_red = matches!(
        reference_phase,
        ControlIndication::Red | ControlIndication::FlashingRed
    );
    let mut movement_states = BTreeMap::new();
    for movement_id in &selection.related_movement_ids {
        let state = if reference_is_red || !selection.stage_movement_ids.contains(movement_id) {
            sibling_phase
        } else {
            reference_phase
        };
        movement_states.insert(movement_id.clone(), state);
        if let Some(requested) = movement_phases.get(movement_id) {
            if *requested != state {
                diagnostics.push(SignalControlDiagnostic {
                    code: SignalControlDiagnosticCode::ConflictingControllerStage,
                    message: format!(
                        "Movement {movement_id} requested {} while controller stage {} requires {}; the safe derived state was used.",
                        requested.as_str(),
                        selection.reference_controller_id,
                        state.as_str()
                    ),
                    head_ids: Vec::new(),
                    movement_ids: vec![selection.reference_movement_id.clone(), movement_id.clone()],
                    controller_ids: index.movements.get(movement_id).map(|m| m.controller_ids.clone()).unwrap_or_default(),
                });
            }
        }
    }
    let mut head_states = BTreeMap::new();
    for head_id in &selection.intersection_head_ids {
        let state = if reference_is_red || !selection.movement_head_ids.contains(head_id) {
            sibling_phase
        } else {
            reference_phase
        };
        head_states.insert(head_id.clone(), state);
    }
    SignalReferenceEvaluation {
        time_seconds,
        head_states,
        movement_states,
        diagnostics,
    }
}

/* -------------------------------------------------------- plan compiler */

pub struct CompileMapSignalPlansOptions<'a> {
    pub map_id: &'a str,
    pub clip_seconds: f64,
    pub warmup_seconds: f64,
    pub signal_catalog: &'a MapSignalCatalog,
    /// Resolved engine signal ids owned by `@world set(signal:*.phase)`.
    pub world_signal_set_ids: &'a [String],
}

const ENDPOINT_PAD_S: f64 = 1e-6;

fn cycle_of(program: &SignalProgram) -> f64 {
    program.phases.iter().map(|p| p.duration_s).sum()
}

fn phase_at(program: &SignalProgram, time_s: f64, warmup_seconds: f64) -> ControlIndication {
    let cycle = cycle_of(program);
    let mut elapsed = time_s + warmup_seconds + program.offset_s;
    let first = program.phases[0].phase;
    let last = program.phases[program.phases.len() - 1].phase;
    if program.loop_ {
        elapsed = ((elapsed % cycle) + cycle) % cycle;
    } else if elapsed <= 0.0 {
        return first;
    } else if elapsed >= cycle {
        return last;
    }
    let mut cursor = 0.0;
    for phase in &program.phases {
        cursor += phase.duration_s;
        if elapsed < cursor {
            return phase.phase;
        }
    }
    last
}

fn add_baseline_boundaries(
    into: &mut Vec<f64>,
    program: &SignalProgram,
    start_s: f64,
    end_s: f64,
    warmup_seconds: f64,
) {
    let cycle = cycle_of(program);
    let mut cumulative = 0.0;
    for phase in &program.phases {
        cumulative += phase.duration_s;
        let origin = cumulative - warmup_seconds - program.offset_s;
        if program.loop_ {
            if cycle <= 0.0 {
                continue;
            }
            let first = ((start_s - origin) / cycle).ceil() as i64;
            let last = ((end_s - origin) / cycle).floor() as i64;
            for turn in first..=last {
                let value = origin + turn as f64 * cycle;
                if value > start_s && value < end_s {
                    into.push(value);
                }
            }
        } else if origin > start_s && origin < end_s {
            into.push(origin);
        }
    }
}

fn plan_error(code: &str, path: String, reason: String) -> CompileError {
    CompileError::at(code, path, reason)
}

fn validate_controller_stage<'p>(
    plan: &MapSignalPlan,
    clip: &MapSignalPlanClip,
    programs: &'p [SignalProgram],
    options: &CompileMapSignalPlansOptions<'_>,
    path: &str,
) -> Result<&'p SignalProgram, CompileError> {
    let junction = options
        .signal_catalog
        .junctions
        .iter()
        .find(|j| j.junction_id == plan.binding.junction_id);
    let controller = options
        .signal_catalog
        .controllers
        .iter()
        .find(|c| c.id == clip.reference.controller_id);
    let (Some(junction), Some(controller)) = (junction, controller) else {
        return Err(plan_error(
            "map_signal_plan_reference_unbound",
            format!("{path}.reference.controllerId"),
            format!(
                "controller \"{}\" does not belong to junction \"{}\"",
                clip.reference.controller_id, plan.binding.junction_id
            ),
        ));
    };
    if !junction
        .controller_ids
        .iter()
        .any(|c| *c == clip.reference.controller_id)
    {
        return Err(plan_error(
            "map_signal_plan_reference_unbound",
            format!("{path}.reference.controllerId"),
            format!(
                "controller \"{}\" does not belong to junction \"{}\"",
                clip.reference.controller_id, plan.binding.junction_id
            ),
        ));
    }
    if !controller
        .signal_ids
        .iter()
        .any(|s| *s == clip.reference.head_id)
    {
        return Err(plan_error(
            "map_signal_plan_reference_unbound",
            format!("{path}.reference.headId"),
            format!(
                "head \"{}\" does not belong to controller \"{}\"",
                clip.reference.head_id, clip.reference.controller_id
            ),
        ));
    }
    programs
        .iter()
        .find(|program| {
            program
                .map_binding
                .as_ref()
                .and_then(|b| b.controller_head_groups.as_ref())
                .is_some_and(|groups| {
                    groups.iter().any(|g| {
                        g.controller_id == clip.reference.controller_id
                            && g.head_ids.iter().any(|h| *h == clip.reference.head_id)
                    })
                })
        })
        .ok_or_else(|| {
            plan_error(
                "map_signal_plan_reference_unbound",
                format!("{path}.reference"),
                format!(
                    "head \"{}\" has no executable program in controller \"{}\"",
                    clip.reference.head_id, clip.reference.controller_id
                ),
            )
        })
}

fn compile_junction(
    programs: &[SignalProgram],
    plan: &MapSignalPlan,
    options: &CompileMapSignalPlansOptions<'_>,
    plan_index: usize,
) -> Result<Vec<SignalProgram>, CompileError> {
    let prefix = format!("mapSignalPlans.{plan_index}");
    if plan.binding.map_id != options.map_id {
        return Err(plan_error(
            "map_signal_plan_map_mismatch",
            format!("{prefix}.binding.mapId"),
            format!(
                "signal plan is bound to map \"{}\", not \"{}\"",
                plan.binding.map_id, options.map_id
            ),
        ));
    }
    let junction_programs: Vec<&SignalProgram> = programs
        .iter()
        .filter(|p| {
            p.map_binding
                .as_ref()
                .is_some_and(|b| b.junction_id == plan.binding.junction_id)
        })
        .collect();
    if junction_programs.is_empty() {
        return Err(plan_error(
            "map_signal_plan_junction_unbound",
            format!("{prefix}.binding.junctionId"),
            format!(
                "junction \"{}\" has no executable physical signal programs",
                plan.binding.junction_id
            ),
        ));
    }
    if let Some(dual) = options
        .world_signal_set_ids
        .iter()
        .find(|id| junction_programs.iter().any(|p| p.id == **id))
    {
        return Err(plan_error(
            "map_signal_plan_dual_ownership",
            prefix,
            format!("signal \"{dual}\" is controlled by both mapSignalPlans and a @world set interaction"),
        ));
    }

    let owned: Vec<SignalProgram> = junction_programs.iter().map(|p| (*p).clone()).collect();
    let physical_heads: Vec<String> = options
        .signal_catalog
        .heads
        .iter()
        .map(|h| h.id.clone())
        .collect();
    let control_index = build_signal_control_index(&owned, &physical_heads);
    let mut phases_by_clip: BTreeMap<String, BTreeMap<String, ControlIndication>> = BTreeMap::new();
    for (clip_index, clip) in plan.clips.iter().enumerate() {
        let clip_path = format!("{prefix}.clips.{clip_index}");
        let reference_program = validate_controller_stage(plan, clip, &owned, options, &clip_path)?;
        let selection = select_signal_reference(
            &control_index,
            &clip.reference.head_id,
            Some(&reference_program.id),
            Some(&clip.reference.controller_id),
        )
        .filter(|s| s.junction_id == plan.binding.junction_id)
        .ok_or_else(|| {
            plan_error(
                "map_signal_plan_reference_unbound",
                format!("{clip_path}.reference"),
                format!(
                    "head \"{}\" cannot resolve an exact movement at junction \"{}\"",
                    clip.reference.head_id, plan.binding.junction_id
                ),
            )
        })?;
        let evaluation = evaluate_signal_reference_phase(
            &control_index,
            &selection,
            clip.start_s,
            clip.indication,
            &BTreeMap::new(),
        );
        let mut by_program = BTreeMap::new();
        for program in &owned {
            let mut distinct: Vec<ControlIndication> = Vec::new();
            for head_id in program
                .map_binding
                .as_ref()
                .map(|b| b.head_ids.as_slice())
                .unwrap_or(&[])
            {
                let state = evaluation
                    .head_states
                    .get(head_id)
                    .copied()
                    .unwrap_or(ControlIndication::Red);
                if !distinct.contains(&state) {
                    distinct.push(state);
                }
            }
            if distinct.len() != 1 {
                return Err(plan_error(
                    "map_signal_plan_controller_conflict",
                    format!("{clip_path}.reference"),
                    format!(
                        "program \"{}\" received incompatible physical-head states {}",
                        program.id,
                        distinct
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ));
            }
            by_program.insert(program.id.clone(), distinct[0]);
        }
        phases_by_clip.insert(clip.id.clone(), by_program);
    }

    let start_s = -options.warmup_seconds;
    let end_s = options.clip_seconds + ENDPOINT_PAD_S;
    let mut points = vec![start_s, 0.0, options.clip_seconds, end_s];
    for clip in &plan.clips {
        points.push(clip.start_s);
        points.push(clip.end_s);
    }
    for program in &owned {
        add_baseline_boundaries(&mut points, program, start_s, end_s, options.warmup_seconds);
    }
    points.retain(|p| *p >= start_s && *p <= end_s);
    points.sort_by(f64::total_cmp);
    points.dedup();

    Ok(owned
        .into_iter()
        .map(|program| {
            let mut phases: Vec<SignalPhase> = Vec::new();
            for window in points.windows(2) {
                let (from, to) = (window[0], window[1]);
                if to <= from {
                    continue;
                }
                let sample = from + (to - from) / 2.0;
                let phase = match plan
                    .clips
                    .iter()
                    .find(|c| sample >= c.start_s && sample < c.end_s)
                {
                    Some(clip) => phases_by_clip[&clip.id][&program.id],
                    None => phase_at(&program, sample, options.warmup_seconds),
                };
                match phases.last_mut() {
                    Some(prev) if prev.phase == phase => prev.duration_s += to - from,
                    _ => phases.push(SignalPhase {
                        phase,
                        duration_s: to - from,
                    }),
                }
            }
            let mut map_binding = program.map_binding.clone();
            if let Some(b) = &mut map_binding {
                b.timing_source = TimingSource::Authored;
            }
            SignalProgram {
                phases,
                offset_s: 0.0,
                loop_: false,
                map_binding,
                ..program
            }
        })
        .collect())
}

/// Compile bounded authoring clips into complete, non-looping engine programs.
/// Baseline map timing is retained during warm-up and every uncovered gap.
pub fn compile_map_signal_plans(
    programs: &[SignalProgram],
    plans: &[MapSignalPlan],
    options: &CompileMapSignalPlansOptions<'_>,
) -> Result<Vec<SignalProgram>, CompileError> {
    let mut output: Vec<SignalProgram> = programs.to_vec();
    for (plan_index, plan) in plans.iter().enumerate() {
        let compiled = compile_junction(&output, plan, options, plan_index)?;
        for replacement in compiled {
            if let Some(slot) = output.iter_mut().find(|p| p.id == replacement.id) {
                *slot = replacement;
            }
        }
    }
    Ok(output)
}
