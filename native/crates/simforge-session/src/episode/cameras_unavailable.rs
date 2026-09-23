//! Browser builds retain the camera schema but cannot instantiate a resident
//! Bevy transport. Uninhabited handles prevent a fake frame/provider fallback.
use serde_json::Value;
use simforge_core::types::SimScenarioInput;
use crate::env::EnvSession;
use crate::error::{Result, SessionError};
use super::camera_types::{CameraBackend, CameraEnhance, CameraObservation, CameraPass, ResidentCameraRig};

#[derive(Clone)]
pub enum FrameRef {}
pub(crate) enum Cameras {}

impl Cameras {
    pub fn new(_: ResidentCameraRig, _: Vec<CameraPass>, _: CameraBackend, _: Option<CameraEnhance>,
               _: &SimScenarioInput, _: u32) -> Result<Self> {
        Err(SessionError::Camera("resident camera backends unavailable on wasm32; use the native Episode binding".into()))
    }
    pub fn ensure_released(&self) -> Result<()> { match *self {} }
    pub fn reset(&mut self) -> Result<()> { match *self {} }
    pub fn render(&mut self, _: &EnvSession) -> Result<()> { match *self {} }
    pub fn renew(&mut self) -> Result<()> { match *self {} }
    pub fn observations(&self) -> &[CameraObservation] { match *self {} }
    pub fn frame(&self, _: u32) -> Result<FrameRef> { match *self {} }
    pub fn frames(&self) -> Result<Vec<FrameRef>> { match *self {} }
    pub fn scene_json(&self) -> &str { match *self {} }
    pub fn evidence(&self) -> Value { match *self {} }
    pub fn close(&mut self) { match *self {} }
}
