//! The typed key registry behind the `set` verb.
//!
//! `set` is the discrete-state escape valve (indicators, doors, a flagger's
//! paddle, a signal phase, behaviour switches). Left open it becomes a
//! stringly-typed channel no engine can implement completely, so the legal
//! keys are data, each with a value type and the actor kinds it applies to,
//! and anything else is refused with the near-miss suggestion. Wildcard keys
//! (`signal:<handle>.phase`) match by pattern, since the handles come from the
//! map. Kept entry for entry with the scenario schema's registry.

/// Value domain of a settable key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueType {
    Boolean,
    Number,
    Enum,
    String,
}

/// Who a key may be set on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppliesTo {
    Vehicle,
    Vru,
    AnyActor,
    World,
}

impl AppliesTo {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vehicle => "vehicle",
            Self::Vru => "vru",
            Self::AnyActor => "any_actor",
            Self::World => "world",
        }
    }
}

/// How a wildcard key is recognised (the registry's regex patterns, spelled
/// out: a prefix, a body drawn from a character class, and a suffix).
#[derive(Debug, Clone, Copy)]
enum Pattern {
    /// `^control:[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}\.indication$`
    Control,
    /// `^signal:[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\.<suffix>$`
    SignalHandle(&'static str),
    /// `^signal:feature:[A-Za-z][A-Za-z0-9_-]{0,63}:(subject|ego|opposing|left|right)\.<suffix>$`
    SignalFeature(&'static str),
}

impl Pattern {
    fn test(self, key: &str) -> bool {
        match self {
            Self::Control => key
                .strip_prefix("control:")
                .and_then(|rest| rest.strip_suffix(".indication"))
                .is_some_and(|body| {
                    handle_body(body, |b| {
                        b.is_ascii_alphanumeric() || b"_.:@/-".contains(&b)
                    })
                }),
            Self::SignalHandle(suffix) => key
                .strip_prefix("signal:")
                .and_then(|rest| rest.strip_suffix(suffix))
                .and_then(|rest| rest.strip_suffix('.'))
                .is_some_and(|body| {
                    handle_body(body, |b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
                }),
            Self::SignalFeature(suffix) => key
                .strip_prefix("signal:feature:")
                .and_then(|rest| rest.strip_suffix(suffix))
                .and_then(|rest| rest.strip_suffix('.'))
                .and_then(|rest| rest.rsplit_once(':'))
                .is_some_and(|(feature, approach)| {
                    matches!(approach, "subject" | "ego" | "opposing" | "left" | "right")
                        && feature.len() <= 64
                        && feature
                            .bytes()
                            .next()
                            .is_some_and(|b| b.is_ascii_alphabetic())
                        && feature
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                }),
        }
    }
}

/// `[A-Za-z0-9]<rest class>{0,127}`.
fn handle_body(body: &str, rest: impl Fn(u8) -> bool) -> bool {
    let bytes = body.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|&b| rest(b))
}

/// One registry entry.
#[derive(Debug, Clone, Copy)]
pub struct SetKeyDecl {
    pub key: &'static str,
    pattern: Option<Pattern>,
    pub value_type: ValueType,
    pub values: &'static [&'static str],
    pub range: Option<(f64, f64)>,
    pub applies_to: AppliesTo,
}

const fn lit(key: &'static str, value_type: ValueType, applies_to: AppliesTo) -> SetKeyDecl {
    SetKeyDecl {
        key,
        pattern: None,
        value_type,
        values: &[],
        range: None,
        applies_to,
    }
}

const fn enm(
    key: &'static str,
    values: &'static [&'static str],
    applies_to: AppliesTo,
) -> SetKeyDecl {
    SetKeyDecl {
        key,
        pattern: None,
        value_type: ValueType::Enum,
        values,
        range: None,
        applies_to,
    }
}

const fn num(key: &'static str, lo: f64, hi: f64, applies_to: AppliesTo) -> SetKeyDecl {
    SetKeyDecl {
        key,
        pattern: None,
        value_type: ValueType::Number,
        values: &[],
        range: Some((lo, hi)),
        applies_to,
    }
}

const fn pat(
    key: &'static str,
    pattern: Pattern,
    value_type: ValueType,
    values: &'static [&'static str],
) -> SetKeyDecl {
    SetKeyDecl {
        key,
        pattern: Some(pattern),
        value_type,
        values,
        range: None,
        applies_to: AppliesTo::World,
    }
}

const SIGNAL_PHASES: &[&str] = &[
    "green",
    "yellow",
    "red",
    "flashing_yellow",
    "flashing_red",
    "off",
    "green_arrow",
    "yellow_arrow",
    "red_x",
    "flashing_yellow_arrow",
    "flashing_red_arrow",
];

const DOOR_STATES: &[&str] = &["closed", "opening", "open", "closing"];

use AppliesTo::{AnyActor, Vehicle, Vru, World};
use ValueType::{Boolean, String as Str};

/// Every key the `set` verb accepts, in registry order.
pub const SET_KEY_REGISTRY: &[SetKeyDecl] = &[
    lit("rules.collisionAvoidance", Boolean, AnyActor),
    pat(
        "control:<id>.indication",
        Pattern::Control,
        ValueType::Enum,
        &[
            "green",
            "yellow",
            "red",
            "flashing_yellow",
            "flashing_red",
            "off",
            "green_arrow",
            "yellow_arrow",
            "red_x",
            "proceed",
            "stop",
        ],
    ),
    lit("rules.obeySignals", Boolean, AnyActor),
    lit("rules.obeySpeedLimit", Boolean, Vehicle),
    lit("rules.yieldToVehicles", Boolean, AnyActor),
    lit("rules.yieldToPedestrians", Boolean, AnyActor),
    num("rules.aggression", 0.0, 1.0, AnyActor),
    lit("rules.laneKeeping", Boolean, Vehicle),
    num("rules.reactionTimeS", 0.0, 3.0, AnyActor),
    enm("motion.gear", &["forward", "reverse"], Vehicle),
    enm(
        "lights.indicator",
        &["off", "left", "right", "hazard"],
        Vehicle,
    ),
    enm("lights.headlights", &["off", "drl", "low", "high"], Vehicle),
    lit("lights.brake", Boolean, Vehicle),
    lit("lights.reverse", Boolean, Vehicle),
    enm(
        "lights.emergency",
        &["off", "flashing", "flashing_siren"],
        Vehicle,
    ),
    lit("audio.horn", Boolean, Vehicle),
    enm("doors.left", DOOR_STATES, Vehicle),
    enm("doors.right", DOOR_STATES, Vehicle),
    enm("doors.rear", DOOR_STATES, Vehicle),
    enm("pose.paddle", &["stowed", "stop", "slow"], Vru),
    enm(
        "pose.stopArm",
        &["retracted", "extending", "extended"],
        Vehicle,
    ),
    enm(
        "pose.gesture",
        &["none", "wave_through", "halt", "point", "phone"],
        Vru,
    ),
    num("pose.headingLookDeg", -180.0, 180.0, Vru),
    pat(
        "signal:<handle>.phase",
        Pattern::SignalHandle("phase"),
        ValueType::Enum,
        SIGNAL_PHASES,
    ),
    pat(
        "signal:<handle>.program",
        Pattern::SignalHandle("program"),
        Str,
        &[],
    ),
    pat(
        "signal:feature:<feature>:<approach>.phase",
        Pattern::SignalFeature("phase"),
        ValueType::Enum,
        SIGNAL_PHASES,
    ),
    pat(
        "signal:feature:<feature>:<approach>.program",
        Pattern::SignalFeature("program"),
        Str,
        &[],
    ),
    enm(
        "env.weather",
        &[
            "clear",
            "cloudy",
            "overcast",
            "light_rain",
            "heavy_rain",
            "wet_road",
            "fog_light",
            "fog_dense",
            "snow",
            "sleet",
        ],
        World,
    ),
    num("env.frictionScale", 0.1, 1.2, World),
    num("env.fogDensity", 0.0, 1.0, World),
    num("env.rainIntensity", 0.0, 1.0, World),
];

/// Look a key up, literal keys first, then the wildcard patterns in order.
pub fn lookup_set_key(key: &str) -> Option<&'static SetKeyDecl> {
    SET_KEY_REGISTRY
        .iter()
        .find(|d| d.pattern.is_none() && d.key == key)
        .or_else(|| {
            SET_KEY_REGISTRY
                .iter()
                .find(|d| d.pattern.is_some_and(|p| p.test(key)))
        })
}

/// Namespace of a key (`rules`, `lights`, `doors`, `pose`, `signal`, `control`, `env`).
pub fn set_key_namespace(key: &str) -> &str {
    if key.starts_with("signal:") {
        return "signal";
    }
    if key.starts_with("control:") {
        return "control";
    }
    key.split_once('.').map_or(key, |(ns, _)| ns)
}

/// Every key, sorted (JavaScript default sort).
fn known_set_keys() -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = SET_KEY_REGISTRY.iter().map(|d| d.key).collect();
    keys.sort_by(|a, b| simforge_core::hash::cmp_utf16(a, b));
    keys
}

/// Cheap edit-distance suggestion for a mistyped key.
fn suggest_set_key(key: &str) -> Option<&'static str> {
    let lowered: Vec<u16> = key.to_lowercase().encode_utf16().collect();
    let mut best: Option<(&'static str, usize)> = None;
    for candidate in known_set_keys() {
        let c: Vec<u16> = candidate.to_lowercase().encode_utf16().collect();
        let score = levenshtein(&lowered, &c);
        if best.is_none_or(|(_, s)| score < s) {
            best = Some((candidate, score));
        }
    }
    let limit = 3usize.max(key.encode_utf16().count() / 3);
    best.filter(|(_, score)| *score <= limit).map(|(k, _)| k)
}

fn levenshtein(a: &[u16], b: &[u16]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (cur[j - 1] + 1).min(prev[j] + 1).min(prev[j - 1] + cost);
        }
        prev.clone_from(&cur);
    }
    prev[b.len()]
}

/// Why a `set` value was refused: `(code, message)`.
pub fn check_set_value(
    key: &str,
    value: &simforge_compiler::template::SetValue,
) -> Result<(), (&'static str, String)> {
    use crate::jsfmt::js;
    use simforge_compiler::template::SetValue;
    let Some(declared) = lookup_set_key(key) else {
        let suggestion = suggest_set_key(key)
            .map(|s| format!("; did you mean \"{s}\"?"))
            .unwrap_or_default();
        return Err((
            "unknown_set_key",
            format!("unknown set key \"{key}\"{suggestion}"),
        ));
    };
    match declared.value_type {
        ValueType::Boolean => match value {
            SetValue::Bool(_) => Ok(()),
            _ => Err(("set_value_type", format!("\"{key}\" takes a boolean"))),
        },
        ValueType::Number => {
            let SetValue::Number(n) = value else {
                return Err(("set_value_type", format!("\"{key}\" takes a number")));
            };
            if let Some((lo, hi)) = declared.range {
                if *n < lo || *n > hi {
                    return Err((
                        "set_value_range",
                        format!(
                            "\"{key}\" must be within [{}, {}], got {}",
                            js(lo),
                            js(hi),
                            js(*n)
                        ),
                    ));
                }
            }
            Ok(())
        }
        ValueType::Enum => match value {
            SetValue::Text(s) if declared.values.contains(&s.as_str()) => Ok(()),
            _ => Err((
                "set_value_type",
                format!("\"{key}\" takes one of: {}", declared.values.join(", ")),
            )),
        },
        ValueType::String => match value {
            SetValue::Text(_) => Ok(()),
            _ => Err(("set_value_type", format!("\"{key}\" takes a string"))),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcards_match_like_the_registry_patterns() {
        assert_eq!(
            lookup_set_key("signal:J12.3.phase").unwrap().key,
            "signal:<handle>.phase"
        );
        assert_eq!(
            lookup_set_key("signal:J12.program").unwrap().key,
            "signal:<handle>.program"
        );
        assert_eq!(
            lookup_set_key("control:work-zone@a/b.indication")
                .unwrap()
                .key,
            "control:<id>.indication"
        );
        assert!(lookup_set_key("control:.indication").is_none());
        assert!(lookup_set_key("signal:.phase").is_none());
        assert_eq!(
            lookup_set_key("rules.aggression").unwrap().key,
            "rules.aggression"
        );
        assert!(lookup_set_key("rules.agression").is_none());
    }

    #[test]
    fn suggestions() {
        assert_eq!(suggest_set_key("rules.agression"), Some("rules.aggression"));
        assert_eq!(
            suggest_set_key("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
            None
        );
        assert_eq!(set_key_namespace("lights.brake"), "lights");
        assert_eq!(set_key_namespace("signal:x.phase"), "signal");
        assert_eq!(set_key_namespace("nodot"), "nodot");
    }
}
