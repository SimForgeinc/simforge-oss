//! Wire types for the native viewport IPC, and the single stdout emitter.
//!
//! `PROTOCOL.md` in this directory is the normative document; this module is
//! its executable half. Every command documented there has an arm in
//! [`ControlCommand`], every event documented there is emitted through
//! [`emit`], and anything else arriving on stdin becomes an `error` event
//! rather than silence — a silently ignored command is indistinguishable from
//! a renderer that is wedged.
//!
//! Casing: commands are kebab-case tags, every field on the wire is
//! camelCase, in both directions. The host is TypeScript and the editor is
//! TypeScript; one casing across the boundary means no translation layer can
//! drift out of step with the doc.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::{LazyLock, Mutex};

/// Commands the host may send. Kept in lockstep with `PROTOCOL.md`; the
/// `every_documented_command_parses` test is the enforcement.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "command", rename_all = "kebab-case")]
pub enum ControlCommand {
    #[serde(rename_all = "camelCase")]
    LoadMap {
        map_root: String,
        map_version_id: String,
        release_digest: String,
    },
    Camera {
        position: [f32; 3],
        target: [f32; 3],
    },
    #[serde(rename_all = "camelCase")]
    PointerRay {
        origin: [f32; 3],
        direction: [f32; 3],
        #[serde(default)]
        layers: Vec<String>,
        max_hits: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    PointerButton {
        button: PointerButton,
        state: KeyState,
        x: f32,
        y: f32,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        key: String,
        state: KeyState,
        #[serde(default)]
        modifiers: Vec<String>,
    },
    Selection {
        ids: Vec<String>,
    },
    /// Overlay payloads stay opaque: the editor owns their schema. Points and
    /// line strips are read out best-effort for drawing; everything else is
    /// preserved untouched and echoed back in `overlay-state`.
    #[serde(rename_all = "camelCase")]
    Overlay {
        id: String,
        visible: bool,
        #[serde(default)]
        payload: Value,
    },
    #[serde(rename_all = "camelCase")]
    Resize {
        width: f32,
        height: f32,
        pixel_ratio: f32,
        x: Option<i32>,
        y: Option<i32>,
    },
    /// Fault injection: drives the same device-lost producer a real wgpu
    /// device-lost callback drives. Kept in the shipped binary because the
    /// recovery path is otherwise only reachable by breaking a GPU.
    #[serde(rename_all = "camelCase")]
    DebugDeviceLost {
        reason: Option<String>,
    },
    Quit,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum PointerButton {
    Primary,
    Secondary,
    Middle,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum KeyState {
    Pressed,
    Released,
}

/// Command names this build accepts. Used only to tell "you sent a command I
/// do not know" apart from "you sent a command I know, malformed".
pub const COMMANDS: [&str; 11] = [
    "load-map",
    "camera",
    "pointer-ray",
    "pointer-button",
    "key",
    "selection",
    "overlay",
    "resize",
    "debug-device-lost",
    "quit",
    // `gizmo` is documented as v2 in PROTOCOL.md and deliberately absent: it
    // is listed here so the rejection says "not implemented in v1" instead of
    // "unknown", which is what a host author needs to hear.
    "gizmo",
];

/// Commands named by the protocol but not implemented by this version.
pub const V2_COMMANDS: [&str; 1] = ["gizmo"];

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Command(ControlCommand),
    /// A line that must produce an `error` event. Carried through the same
    /// channel as accepted commands so events stay in arrival order.
    Rejected {
        code: &'static str,
        message: String,
    },
}

/// Classify one stdin line. Never silently drops input.
pub fn parse_incoming(line: &str) -> Incoming {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return Incoming::Rejected {
                code: "malformed_json",
                message: format!("command line is not JSON: {error}"),
            }
        }
    };
    let name = value.get("command").and_then(Value::as_str).map(str::to_owned);
    let Some(name) = name else {
        return Incoming::Rejected {
            code: "missing_command",
            message: "command object requires a string `command` field".to_owned(),
        };
    };
    if V2_COMMANDS.contains(&name.as_str()) {
        return Incoming::Rejected {
            code: "command_not_implemented",
            message: format!("`{name}` is documented as protocol v2 and is not implemented by this build"),
        };
    }
    if !COMMANDS.contains(&name.as_str()) {
        return Incoming::Rejected {
            code: "unknown_command",
            message: format!("unknown command `{name}`; supported: {}", COMMANDS.join(", ")),
        };
    }
    match serde_json::from_value::<ControlCommand>(value) {
        Ok(command) => Incoming::Command(command),
        Err(error) => Incoming::Rejected {
            code: "malformed_command",
            message: format!("`{name}` payload is invalid: {error}"),
        },
    }
}

/// Immutable identity of the loaded map, stamped onto every event so the host
/// can correlate a stream with the manifest it asked for.
#[derive(Clone, Default, Debug)]
pub struct Identity {
    pub map_version_id: String,
    pub release_digest: String,
    pub canonical_digest: Option<String>,
}

static IDENTITY: LazyLock<Mutex<Identity>> = LazyLock::new(|| Mutex::new(Identity::default()));

pub fn set_identity(identity: Identity) {
    *IDENTITY.lock().expect("identity lock") = identity;
}

pub fn identity() -> Identity {
    IDENTITY.lock().expect("identity lock").clone()
}

/// Build one event object: `event`, then identity, then the caller's fields.
pub fn event_value(event: &str, fields: Value) -> Value {
    let identity = identity();
    let mut object = Map::new();
    object.insert("event".to_owned(), json!(event));
    object.insert("mapVersionId".to_owned(), json!(identity.map_version_id));
    object.insert("releaseDigest".to_owned(), json!(identity.release_digest));
    if let Some(canonical) = identity.canonical_digest {
        object.insert("canonicalDigest".to_owned(), json!(canonical));
    }
    object.insert("renderer".to_owned(), json!(super::RENDERER_ID));
    if let Value::Object(extra) = fields {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }
    Value::Object(object)
}

/// Write one newline-delimited event to stdout under the stdout lock, so a
/// render-world thread and the main schedule cannot interleave a line.
pub fn emit(event: &str, fields: Value) {
    let line = serde_json::to_string(&event_value(event, fields)).expect("renderer event serializes");
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(line.as_bytes());
    let _ = handle.write_all(b"\n");
    let _ = handle.flush();
}

pub fn emit_error(code: &str, message: impl AsRef<str>) {
    emit("error", json!({ "code": code, "message": message.as_ref() }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command line that `PROTOCOL.md` documents for v1 must parse, and
    /// the v2 arm must be rejected as not-implemented rather than unknown.
    #[test]
    fn every_documented_command_parses() {
        let lines = [
            r#"{"command":"load-map","mapRoot":"/maps/x","mapVersionId":"m","releaseDigest":"d"}"#,
            r#"{"command":"camera","position":[0,25,45],"target":[0,0,0]}"#,
            r#"{"command":"pointer-ray","origin":[0,1,2],"direction":[0,-1,0],"layers":["ground"],"maxHits":8}"#,
            r#"{"command":"pointer-button","button":"primary","state":"pressed","x":0.2,"y":-0.1}"#,
            r#"{"command":"key","key":"Escape","state":"pressed","modifiers":[]}"#,
            r#"{"command":"selection","ids":["actor:1"]}"#,
            r#"{"command":"overlay","id":"coverage","visible":true,"payload":{"points":[],"lines":[]}}"#,
            r#"{"command":"resize","width":1600,"height":1000,"pixelRatio":1}"#,
            r#"{"command":"debug-device-lost","reason":"injected"}"#,
            r#"{"command":"quit"}"#,
        ];
        for line in lines {
            assert!(
                matches!(parse_incoming(line), Incoming::Command(_)),
                "documented command must parse: {line}"
            );
        }
        assert_eq!(
            parse_incoming(r#"{"command":"gizmo","operation":"translate","ids":[],"delta":[0,0,0]}"#),
            Incoming::Rejected {
                code: "command_not_implemented",
                message: "`gizmo` is documented as protocol v2 and is not implemented by this build".to_owned(),
            }
        );
    }

    #[test]
    fn unknown_and_malformed_commands_are_rejected_distinctly() {
        assert!(matches!(
            parse_incoming(r#"{"command":"teleport"}"#),
            Incoming::Rejected { code: "unknown_command", .. }
        ));
        assert!(matches!(
            parse_incoming(r#"{"command":"camera","position":[1],"target":[0,0,0]}"#),
            Incoming::Rejected { code: "malformed_command", .. }
        ));
        assert!(matches!(
            parse_incoming("not json"),
            Incoming::Rejected { code: "malformed_json", .. }
        ));
        assert!(matches!(
            parse_incoming(r#"{"position":[1,2,3]}"#),
            Incoming::Rejected { code: "missing_command", .. }
        ));
    }

    #[test]
    fn commands_use_camel_case_fields() {
        let parsed = parse_incoming(
            r#"{"command":"resize","width":800,"height":600,"pixelRatio":2,"x":10,"y":20}"#,
        );
        assert_eq!(
            parsed,
            Incoming::Command(ControlCommand::Resize {
                width: 800.0,
                height: 600.0,
                pixel_ratio: 2.0,
                x: Some(10),
                y: Some(20),
            })
        );
        // snake_case is not accepted: one casing, enforced.
        assert!(matches!(
            parse_incoming(r#"{"command":"resize","width":800,"height":600,"pixel_ratio":2}"#),
            Incoming::Rejected { code: "malformed_command", .. }
        ));
    }

    #[test]
    fn events_carry_camel_case_identity() {
        set_identity(Identity {
            map_version_id: "map-v1".to_owned(),
            release_digest: "abc".to_owned(),
            canonical_digest: Some("def".to_owned()),
        });
        let value = event_value("coarse-ready", json!({ "elapsedMs": 12 }));
        assert_eq!(value["event"], "coarse-ready");
        assert_eq!(value["mapVersionId"], "map-v1");
        assert_eq!(value["releaseDigest"], "abc");
        assert_eq!(value["canonicalDigest"], "def");
        assert_eq!(value["elapsedMs"], 12);
        assert!(value.get("map_version_id").is_none());
    }
}
