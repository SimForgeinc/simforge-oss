//! Portable camera specification and transport-independent observation metadata.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraSpec {
    pub sensor_id: String,
    pub camera_id: u32,
    pub fwd: f64,
    pub left: f64,
    pub up: f64,
    pub yaw_deg: f64,
    #[serde(default)]
    pub pitch_deg: f64,
    pub hfov: f64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResidentCameraRig {
    pub cameras: Vec<CameraSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CameraPass { Rgb, Depth, Seg }

impl CameraPass {
    pub(crate) fn wire(self) -> &'static str {
        match self { Self::Rgb => "rgb", Self::Depth => "depth", Self::Seg => "semantic" }
    }
    pub(crate) fn public(self) -> &'static str {
        match self { Self::Rgb => "rgb", Self::Depth => "depth", Self::Seg => "seg" }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum CameraBackend {
    Embedded {
        scene: Value,
        #[serde(default)]
        library: Option<String>,
        #[serde(default = "default_shm_size", rename = "shmSizeBytes")]
        shm_size_bytes: u64,
    },
    Service { socket: String },
}
fn default_shm_size() -> u64 { 256 * 1024 * 1024 }

/// Optional, trusted local frame filter. The raw RGB pass is never replaced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraEnhance {
    pub socket: String,
    /// Content-addressed model/preprocessing identity, retained in trace v2.
    pub identity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub id: u32,
    pub tick: u64,
    pub format: String,
    pub row_stride: usize,
    /// CRC32 and SHA256 both cover the complete row-padded payload.
    pub digest: String,
    pub sha256: String,
    pub shm: String,
    /// Payload offset (not the renderer's 128-byte record-header offset).
    pub offset: usize,
    pub len: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraObservation {
    pub sensor_id: String,
    pub pass: String,
    pub width: u32,
    pub height: u32,
    pub frame: FrameDescriptor,
    /// Measured filter round-trip; telemetry only, excluded from trace identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enhance_ms: Option<f64>,
}
