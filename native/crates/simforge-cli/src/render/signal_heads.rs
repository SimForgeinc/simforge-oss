//! Traffic-signal heads for the native renderer: the port of
//! packages/render/src/native/signal-heads.ts.
//!
//! The render timeline names a head `signal:<OpenDRIVE signal id>`; the map
//! GLB names the head node after the RoadRunner asset GUID the OpenDRIVE
//! `<signal>` carries as `<userData><vectorSignal signalId="{guid}"/>`. Each
//! frame lights exactly one lens per head; what cannot be bound as asked is
//! recorded as a warning, never dropped in silence.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::contract::CliError;

pub const TIMELINE_SIGNAL_PREFIX: &str = "signal:";
const FLASH_PERIOD_S: f64 = 1.0;
const FLASH_DUTY: f64 = 0.5;

pub fn flash_on(t: f64) -> bool {
    let phase = t - FLASH_PERIOD_S * (t / FLASH_PERIOD_S).floor();
    phase < FLASH_PERIOD_S * FLASH_DUTY
}

fn regexes() -> &'static (Regex, Regex, Regex) {
    static R: OnceLock<(Regex, Regex, Regex)> = OnceLock::new();
    R.get_or_init(|| {
        (
            Regex::new(r#"<signal\b([^>]*?)(/>|>([\s\S]*?)</signal>)"#).expect("signal regex"),
            Regex::new(r#"\bid="([^"]+)""#).expect("id regex"),
            Regex::new(r#"<vectorSignal\b[^>]*\bsignalId="(\{[0-9a-fA-F-]{36}\})""#)
                .expect("guid regex"),
        )
    })
}

/// OpenDRIVE signal id -> head GUID (lowercase, braced), in document order.
/// A later `<signal>` with the same id replaces the earlier binding (as the
/// TypeScript `Map.set` did).
pub fn signal_head_guids(xodr: &str) -> BTreeMap<String, String> {
    let (signal, id, guid) = regexes();
    let mut out = BTreeMap::new();
    for m in signal.captures_iter(xodr) {
        let attributes = m.get(1).map_or("", |g| g.as_str());
        let body = m.get(3).map_or("", |g| g.as_str());
        let (Some(id), Some(guid)) = (id.captures(attributes), guid.captures(body)) else {
            continue;
        };
        out.insert(id[1].to_owned(), guid[1].to_lowercase());
    }
    out
}

/// The lens a three-lamp head lights for `indication` at clip time `t`, and
/// whether the indication is an arrow or symbol the round lens substitutes.
pub fn signal_lens(indication: &str, t: f64) -> Result<(&'static str, bool), CliError> {
    let flash = |lens: &'static str| if flash_on(t) { lens } else { "off" };
    Ok(match indication {
        "red" => ("red", false),
        "yellow" => ("yellow", false),
        "green" => ("green", false),
        "off" => ("off", false),
        "flashing_yellow" => (flash("yellow"), false),
        "flashing_red" => (flash("red"), false),
        "flashing_yellow_arrow" => (flash("yellow"), true),
        "flashing_red_arrow" => (flash("red"), true),
        "green_arrow" | "proceed" => ("green", true),
        "yellow_arrow" => ("yellow", true),
        "red_x" | "stop" => ("red", true),
        other => {
            return Err(CliError::findings(
                "native_signal_indication_unknown",
                format!(
                    "render timeline indication {}",
                    serde_json::to_string(other).expect("string")
                ),
            ))
        }
    })
}

/// What binding a timeline's signals to rendered heads could not do as asked.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SignalEvidence {
    pub unbound: BTreeSet<String>,
    /// guid -> the timeline signal ids that disagreed on it.
    pub conflicts: BTreeMap<String, BTreeSet<String>>,
    /// Insertion order is not observable: warnings list them sorted.
    pub substituted: BTreeSet<String>,
}

/// One frame's `signals` for the service: head GUID -> lens. A head bound by
/// several signal ids shows the lens of the smallest id; a disagreement is
/// recorded.
pub fn resolve_frame_signals(
    indications: &BTreeMap<String, String>,
    t: f64,
    guids: &BTreeMap<String, String>,
    evidence: &mut SignalEvidence,
) -> Result<serde_json::Map<String, Value>, CliError> {
    let mut out = serde_json::Map::new();
    let mut owner: BTreeMap<&str, &str> = BTreeMap::new();
    // BTreeMap iteration is the TypeScript `Object.keys(...).sort()` order
    // (the keys are ASCII).
    for (key, indication) in indications {
        let id = key
            .strip_prefix(TIMELINE_SIGNAL_PREFIX)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                CliError::findings(
                    "native_signal_key_invalid",
                    format!(
                        "render timeline signal key {} is not signal:<OpenDRIVE id>",
                        serde_json::to_string(key).expect("string")
                    ),
                )
            })?;
        let (lens, substituted) = signal_lens(indication, t)?;
        if substituted {
            evidence.substituted.insert(indication.clone());
        }
        let Some(guid) = guids.get(id) else {
            evidence.unbound.insert(id.to_owned());
            continue;
        };
        if let Some(previous) = owner.get(guid.as_str()) {
            if out.get(guid).and_then(Value::as_str) != Some(lens) {
                let ids = evidence.conflicts.entry(guid.clone()).or_default();
                ids.insert((*previous).to_owned());
                ids.insert(id.to_owned());
            }
            continue;
        }
        owner.insert(guid, id);
        out.insert(guid.clone(), json!(lens));
    }
    Ok(out)
}

/// Manifest warnings for a lowering's signal binding (`{code, message}`).
pub fn signal_binding_warnings(evidence: &SignalEvidence) -> Vec<Value> {
    let list = |items: &[String]| {
        if items.len() > 12 {
            format!("{} and {} more", items[..12].join(", "), items.len() - 12)
        } else {
            items.join(", ")
        }
    };
    let mut warnings = Vec::new();
    if !evidence.unbound.is_empty() {
        let items: Vec<String> = evidence.unbound.iter().cloned().collect();
        warnings.push(json!({
            "code": "native_signal_unbound",
            "message": format!("timeline signal(s) {} have no rendered head (their OpenDRIVE <signal> names no vectorSignal asset); nothing shows their indication", list(&items)),
        }));
    }
    for (guid, ids) in &evidence.conflicts {
        let items: Vec<String> = ids.iter().cloned().collect();
        warnings.push(json!({
            "code": "native_signal_head_conflict",
            "message": format!("signal head {guid} is driven by timeline signals {}, which disagree; it shows the lens of signal {}", list(&items), items[0]),
        }));
    }
    if !evidence.substituted.is_empty() {
        let items: Vec<String> = evidence.substituted.iter().cloned().collect();
        warnings.push(json!({
            "code": "native_signal_lens_substituted",
            "message": format!("indication(s) {} are drawn on the round lens of their colour (the map's heads have no arrow or symbol lenses)", list(&items)),
        }));
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    const XODR: &str = r#"<OpenDRIVE>
  <road id="1"><signals>
    <signal name="Signal_3Light_Post01" id="5814" s="9.02" t="1.95" dynamic="yes" type="1000011">
      <validity fromLane="0" toLane="0"/>
      <userData><vectorSignal signalId="{792C9DF6-88ce-45b8-a711-1db32acf567e}"/></userData>
    </signal>
    <signal name="" id="6042" s="36.39" t="0" dynamic="yes" type="1000011" subtype="20">
      <userData><vectorSignal gateId="{20088a8a-026f-4b13-9474-fcf658954885}" turnRelation="Right"/></userData>
    </signal>
    <signal name="Signal_3Light_Bare01" id="5815" s="2" t="0"><userData><vectorSignal signalId="{00000000-0000-4000-8000-000000000002}"/></userData></signal>
    <signal id="7000" s="1" t="0"/>
    <signalReference id="5814" s="0" t="0" orientation="-"><userData><vectorSignal signalId="{792c9df6-88ce-45b8-a711-1db32acf567e}" gateId="{5831289a-2b73-4c31-a702-bb70a90b80ba}"/></userData></signalReference>
  </signals></road>
</OpenDRIVE>"#;

    #[test]
    fn binds_opendrive_signal_ids_to_the_glb_head_guid() {
        let guids: Vec<(String, String)> = signal_head_guids(XODR).into_iter().collect();
        assert_eq!(
            guids,
            vec![
                (
                    "5814".into(),
                    "{792c9df6-88ce-45b8-a711-1db32acf567e}".into()
                ),
                (
                    "5815".into(),
                    "{00000000-0000-4000-8000-000000000002}".into()
                ),
            ]
        );
    }

    #[test]
    fn lights_exactly_one_lens_flashing_on_the_timeline_clock() {
        assert_eq!(signal_lens("red", 3.2).unwrap(), ("red", false));
        assert_eq!(signal_lens("off", 0.0).unwrap(), ("off", false));
        assert!(flash_on(0.0) && flash_on(0.49) && !flash_on(0.5));
        assert_eq!(signal_lens("flashing_red", 2.25).unwrap().0, "red");
        assert_eq!(signal_lens("flashing_red", 2.75).unwrap().0, "off");
        assert_eq!(signal_lens("green_arrow", 0.0).unwrap(), ("green", true));
        assert_eq!(signal_lens("stop", 0.0).unwrap(), ("red", true));
        assert_eq!(
            signal_lens("purple", 0.0).unwrap_err().code,
            "native_signal_indication_unknown"
        );
    }

    #[test]
    fn resolves_a_frame_by_head_guid_and_records_what_it_cannot_bind() {
        let mut guids = signal_head_guids(XODR);
        guids.insert(
            "5816".into(),
            "{792c9df6-88ce-45b8-a711-1db32acf567e}".into(),
        );
        let mut evidence = SignalEvidence::default();
        let indications: BTreeMap<String, String> = [
            ("signal:5814", "red"),
            ("signal:5816", "green"),
            ("signal:5815", "green_arrow"),
            ("signal:6042", "green"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        let frame = resolve_frame_signals(&indications, 1.0, &guids, &mut evidence).unwrap();
        assert_eq!(
            Value::Object(frame),
            json!({ "{792c9df6-88ce-45b8-a711-1db32acf567e}": "red", "{00000000-0000-4000-8000-000000000002}": "green" })
        );
        assert_eq!(evidence.unbound.iter().collect::<Vec<_>>(), vec!["6042"]);
        assert_eq!(
            evidence.conflicts["{792c9df6-88ce-45b8-a711-1db32acf567e}"]
                .iter()
                .collect::<Vec<_>>(),
            vec!["5814", "5816"]
        );
        let codes: Vec<Value> = signal_binding_warnings(&evidence)
            .iter()
            .map(|w| w["code"].clone())
            .collect();
        assert_eq!(
            codes,
            vec![
                "native_signal_unbound",
                "native_signal_head_conflict",
                "native_signal_lens_substituted"
            ]
        );
        let bad: BTreeMap<String, String> = [("5814".to_owned(), "red".to_owned())].into();
        assert_eq!(
            resolve_frame_signals(&bad, 0.0, &guids, &mut evidence)
                .unwrap_err()
                .code,
            "native_signal_key_invalid"
        );
    }
}
