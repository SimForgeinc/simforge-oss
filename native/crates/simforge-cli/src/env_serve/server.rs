//! The episode server: one [`Env`] (the same episode, action row,
//! observation layout and checkpoints as the Python `_native` session),
//! optionally one in-process renderer, one Unix socket. Connections are
//! served one at a time; a request always gets exactly one response.

use std::io::{BufReader, BufWriter};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};
use simforge_bindings_common::runtime::{Env, StepView};
use simforge_core::rng::Seed;

use super::frames::FrameBuilder;
use super::sensors::{SensorFrame, Sensors};
use super::wire::{self, Message, Tail, PROTOCOL};
use crate::contract::CliError;

/// Rendered observations: the renderer and the frame builder that feeds it.
pub struct Rendering {
    pub sensors: Sensors,
    pub frames: FrameBuilder,
    /// Sensor descriptions for `hello`.
    pub describe: Value,
}

pub struct Server {
    pub env: Env,
    pub rendering: Option<Rendering>,
    /// Static facts `hello` reports besides the spaces.
    pub hello_extra: Value,
    pub warnings: Vec<Value>,
    reset_done: bool,
    last_sim_time: f64,
}

fn error_header(i: &Value, op: &str, error: &CliError) -> Value {
    let mut header =
        json!({ "ok": false, "i": i, "op": op, "code": error.code, "reason": error.reason });
    if let Some(detail) = &error.detail {
        header["detail"] = detail.clone();
    }
    header
}

fn binding(e: simforge_bindings_common::BindingError) -> CliError {
    CliError::new("episode_error", e.to_string())
}

impl Server {
    pub fn new(
        env: Env,
        rendering: Option<Rendering>,
        hello_extra: Value,
        warnings: Vec<Value>,
    ) -> Self {
        Self {
            env,
            rendering,
            hello_extra,
            warnings,
            reset_done: false,
            last_sim_time: 0.0,
        }
    }

    fn hello(&self) -> Value {
        let bev = self.env.bev_shape().map(|(h, w, c)| json!([h, w, c]));
        let mut header = json!({
            "ok": true,
            "protocol": PROTOCOL,
            "version": env!("CARGO_PKG_VERSION"),
            "engineVersion": simforge_bindings_common::ENGINE_SEM_VER,
            "engineHz": simforge_bindings_common::ENGINE_HZ,
            "ego": self.env.ego(),
            "decisionHz": self.env.decision_hz(),
            "decisionTicks": self.env.decision_ticks(),
            "clipSeconds": self.env.clip_seconds(),
            "actionWidth": simforge_bindings_common::action::ACTION_WIDTH,
            "actionFields": simforge_bindings_common::action::ACTION_FIELD_NAMES,
            "stateVectorSize": simforge_bindings_common::STATE_VECTOR_SIZE,
            "stateVectorEnabled": self.env.state_vector_enabled(),
            "objectFeatures": simforge_bindings_common::OBJECT_FEATURES,
            "maxObjects": self.env.max_objects(),
            "bevShape": bev,
            "sensors": self.rendering.as_ref().map(|r| r.describe.clone()).unwrap_or(json!([])),
            "warnings": self.warnings,
        });
        if let (Value::Object(h), Value::Object(extra)) = (&mut header, &self.hello_extra) {
            for (k, v) in extra {
                h.insert(k.clone(), v.clone());
            }
        }
        header
    }

    fn step_header(
        view: &StepView<'_>,
        ego: &str,
        max_objects: usize,
        tail: &mut Tail,
    ) -> Result<Value, CliError> {
        let state = view.state_vector();
        let mut observation = json!({
            "state_vector": tail.f64s(state, &[state.len()]),
            "objects": tail.f32s(view.objects(), &[max_objects, simforge_bindings_common::OBJECT_FEATURES]),
        });
        if let Some(((h, w, c), data)) = view.bev() {
            observation["bev"] = tail.f32s(data, &[h, w, c]);
        }
        let [progress, proximity, comfort] = view.reward_terms();
        let mut info = json!({
            "t_s": view.t_s(),
            "ego": ego,
            "object_ids": view.object_ids(),
            "reward_terms": { "progress": progress, "proximity": proximity, "comfort": comfort },
        });
        let channel: Value = serde_json::from_str(&view.info_json().map_err(binding)?)
            .map_err(|e| CliError::new("internal_error", format!("info JSON: {e}")))?;
        if let (Value::Object(info), Value::Object(channel)) = (&mut info, channel) {
            info.extend(channel);
        }
        Ok(json!({
            "ok": true,
            "t_s": view.t_s(),
            "reward": view.reward(),
            "terminated": view.terminated(),
            "truncated": view.truncated(),
            "observation": observation,
            "info": info,
        }))
    }

    /// Render the current state (`fresh`: a new stream) into `header.sensors`.
    fn render(
        &mut self,
        header: &mut Value,
        tail: &mut Tail,
        mode: RenderMode,
    ) -> Result<(), CliError> {
        let Some(r) = self.rendering.as_mut() else {
            return Ok(());
        };
        let started = Instant::now();
        let frames: Vec<SensorFrame> = match mode {
            RenderMode::Again => r.sensors.rerender(self.last_sim_time)?,
            RenderMode::Fresh | RenderMode::Next => {
                if mode == RenderMode::Fresh {
                    r.frames.restart();
                }
                let frame = r.frames.frame(&self.env)?;
                let t = frame["t"].as_f64().unwrap_or(0.0);
                self.last_sim_time = t;
                r.sensors.render(frame, mode == RenderMode::Fresh, t)?
            }
        };
        let mut sensors = serde_json::Map::new();
        for f in frames {
            let shape: Vec<usize> = match f.format.as_str() {
                "rgba8" => vec![f.height as usize, f.width as usize, 4],
                "depth32f" => vec![f.height as usize, f.width as usize],
                _ => vec![f.data.len()],
            };
            let mut reference = if f.format == "depth32f" {
                let floats: Vec<f32> = f
                    .data
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes(c.try_into().expect("4 bytes")))
                    .collect();
                tail.f32s(&floats, &shape)
            } else {
                tail.u8s(&f.data, &shape)
            };
            reference["format"] = json!(f.format);
            reference["width"] = json!(f.width);
            reference["height"] = json!(f.height);
            sensors
                .entry(f.sensor_id)
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .expect("object")
                .insert(f.pass, reference);
        }
        header["sensors"] = Value::Object(sensors);
        header["renderMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
        header["renderWarnings"] = json!(r.frames.signal_warnings());
        Ok(())
    }

    /// Handle one request; returns the response and whether to shut down.
    pub fn handle(&mut self, request: &Message) -> (Value, Vec<u8>, bool) {
        let i = request.header.get("i").cloned().unwrap_or(Value::Null);
        let op = request.header["op"].as_str().unwrap_or("").to_owned();
        let mut tail = Tail::default();
        let result = self.dispatch(&op, request, &mut tail);
        match result {
            Ok((mut header, close)) => {
                header["i"] = i;
                header["op"] = json!(op);
                (header, tail.bytes, close)
            }
            Err(error) => (error_header(&i, &op, &error), Vec::new(), false),
        }
    }

    fn observation(&mut self, tail: &mut Tail, mode: RenderMode) -> Result<Value, CliError> {
        let ego = self.env.ego().to_owned();
        let max = self.env.max_objects();
        let mut header = Self::step_header(&self.env.view(), &ego, max, tail)?;
        self.render(&mut header, tail, mode)?;
        Ok(header)
    }

    fn dispatch(
        &mut self,
        op: &str,
        request: &Message,
        tail: &mut Tail,
    ) -> Result<(Value, bool), CliError> {
        let h = &request.header;
        match op {
            "hello" => Ok((self.hello(), false)),
            "reset" => {
                let seed = match &h["seed"] {
                    Value::Null => None,
                    Value::String(s) => Some(Seed::Text(s.clone())),
                    Value::Number(n) => Some(Seed::Number(n.as_f64().filter(|v| v.is_finite()).ok_or_else(|| {
                        CliError::new("bad_value", "seed must be finite").with_path("seed")
                    })?)),
                    _ => {
                        return Err(CliError::new("bad_value", "seed must be a number, a string or null").with_path("seed"))
                    }
                };
                self.env.reset(seed).map_err(binding)?;
                self.reset_done = true;
                Ok((self.observation(tail, RenderMode::Fresh)?, false))
            }
            "step" => {
                if !self.reset_done {
                    return Err(CliError::new("episode_not_reset", "reset the episode before stepping"));
                }
                let row: Option<Vec<f64>> = match &h["action"] {
                    Value::Null => None,
                    Value::Array(values) => Some(
                        values
                            .iter()
                            .map(|v| match v {
                                Value::Null => Some(f64::NAN),
                                other => other.as_f64(),
                            })
                            .collect::<Option<Vec<f64>>>()
                            .ok_or_else(|| {
                                CliError::new("bad_value", "action must be an array of numbers (null = NaN, unset)")
                                    .with_path("action")
                            })?,
                    ),
                    _ => return Err(CliError::new("bad_value", "action must be an array or null").with_path("action")),
                };
                self.env.step(row.as_deref()).map_err(binding)?;
                Ok((self.observation(tail, RenderMode::Next)?, false))
            }
            "observe" => {
                if !self.reset_done {
                    return Err(CliError::new("episode_not_reset", "reset the episode before observing"));
                }
                Ok((self.observation(tail, RenderMode::Again)?, false))
            }
            "checkpoint" => {
                let bytes = self.env.checkpoint().map_err(binding)?;
                let reference = tail.raw(&bytes);
                Ok((json!({ "ok": true, "checkpoint": reference }), false))
            }
            "restore" => {
                let bytes = wire::slice(&request.tail, &h["checkpoint"]).ok_or_else(|| {
                    CliError::new("bad_value", "restore needs a checkpoint payload reference").with_path("checkpoint")
                })?;
                self.env.restore(bytes).map_err(binding)?;
                self.reset_done = true;
                // The renderer starts a new stream at the restored instant.
                Ok((self.observation(tail, RenderMode::Fresh)?, false))
            }
            "close" => Ok((json!({ "ok": true }), true)),
            other => Err(CliError::new("unknown_op", format!("unknown op {other:?}"))
                .with_detail(json!({ "known": ["hello", "reset", "step", "observe", "checkpoint", "restore", "close"] }))),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RenderMode {
    /// A new stream at the current instant (reset, restore).
    Fresh,
    /// The next frame of the stream (step).
    Next,
    /// The current frame again (observe).
    Again,
}

/// Bind `socket`, refusing a live one and replacing a stale file.
pub fn bind(socket: &Path) -> Result<UnixListener, CliError> {
    if socket.exists() {
        if UnixStream::connect(socket).is_ok() {
            return Err(CliError::new(
                "socket_in_use",
                format!("{} is served by another process", socket.display()),
            )
            .with_path("--socket"));
        }
        std::fs::remove_file(socket).map_err(|e| {
            CliError::new(
                "socket_unavailable",
                format!("cannot remove stale {}: {e}", socket.display()),
            )
            .with_path("--socket")
        })?;
    }
    UnixListener::bind(socket).map_err(|e| {
        CliError::new(
            "socket_unavailable",
            format!("cannot bind {}: {e}", socket.display()),
        )
        .with_path("--socket")
    })
}

/// Serve connections until a `close` request.
pub fn serve(server: &mut Server, listener: &UnixListener) -> std::io::Result<()> {
    for stream in listener.incoming() {
        let stream = stream?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut writer = BufWriter::new(stream);
        loop {
            let message = match wire::read_message(&mut reader) {
                Ok(Some(message)) => message,
                Ok(None) => break,
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    let header =
                        json!({ "ok": false, "code": "bad_message", "reason": error.to_string() });
                    let _ = wire::write_message(&mut writer, &header, &[]);
                    break;
                }
                Err(_) => break,
            };
            let (header, tail, close) = server.handle(&message);
            if wire::write_message(&mut writer, &header, &tail).is_err() {
                break;
            }
            if close {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Socket and ring files unlinked by the signal handler.
pub static CLEANUP: std::sync::OnceLock<Vec<std::ffi::CString>> = std::sync::OnceLock::new();

extern "C" fn on_signal(_: libc::c_int) {
    if let Some(paths) = CLEANUP.get() {
        for path in paths {
            // SAFETY: unlink is async-signal-safe; the CStrings live forever.
            unsafe { libc::unlink(path.as_ptr()) };
        }
    }
    // SAFETY: _exit is async-signal-safe.
    unsafe { libc::_exit(0) };
}

/// SIGINT/SIGTERM: remove the socket (and ring) and exit 0.
pub fn install_signal_handlers(paths: &[PathBuf]) {
    use std::os::unix::ffi::OsStrExt;
    let _ = CLEANUP.set(
        paths
            .iter()
            .filter_map(|p| std::ffi::CString::new(p.as_os_str().as_bytes()).ok())
            .collect(),
    );
    // SAFETY: installing a plain C handler.
    unsafe {
        let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
}
