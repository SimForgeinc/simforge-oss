//! Output intent, independent of lighting and renderer implementation.
//! A new consumer supplies this document; it does not add capture CLI flags.
use serde::{Deserialize, Serialize};

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="lowercase")]
pub enum OutputMode { Training, Showcase }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum RgbProduct { Jpeg {quality:u8}, Png, Video {encoder:VideoEncoder,quality:u32} }
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum VideoEncoder { X264, Nvenc, GpuNvenc }
impl VideoEncoder {
    pub fn as_str(self)-> &'static str {match self {Self::X264=>"x264",Self::Nvenc=>"nvenc",Self::GpuNvenc=>"gpu-nvenc"}}
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum DepthProduct { ReverseZ32, ReverseZ16, MetricAxial {scale:u32} }
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all="snake_case")]
pub enum PointEncoding { Ascii, Binary }

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrajectorySamples { pub points:u32, pub hz:f64 }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ConsumerSpec {
    pub name:String,
    /// Temporal RGB window ending at the current sample, spaced at cameraHz.
    pub camera_history_frames:u32,
    pub ego_history:TrajectorySamples,
    pub future_target:TrajectorySamples,
    pub camera_hz:f64,
    pub width:u32,
    pub height:u32,
    pub rgb:RgbProduct,
    pub depth:Option<DepthProduct>,
    pub labels:bool,
    pub lidar:Option<PointEncoding>,
    pub radar:Option<PointEncoding>,
    /// Return-derived BEV and free-space, in the sensor's host-actor frame.
    pub occupancy:bool,
}
impl OutputMode {
    pub fn consumer(self)->ConsumerSpec {
        match self {
            Self::Training=>ConsumerSpec::qwen_drive(),
            Self::Showcase=>ConsumerSpec {name:"showcase".into(),camera_history_frames:1,
                ego_history:TrajectorySamples {points:16,hz:10.0},future_target:TrajectorySamples {points:50,hz:10.0},
                camera_hz:50.0,width:1920,height:1080,
                rgb:RgbProduct::Video {encoder:VideoEncoder::X264,quality:18},depth:None,labels:false,
                lidar:None,radar:None,occupancy:false},
        }
    }
}
impl ConsumerSpec {
    pub fn qwen_drive()->Self {
        static SPEC:std::sync::LazyLock<ConsumerSpec>=std::sync::LazyLock::new(||
            serde_json::from_str(include_str!("../consumers/qwen-drive.json")).expect("embedded Qwen-Drive contract"));
        SPEC.clone()
    }
    pub fn alpamayo_r1()->Self {
        static SPEC:std::sync::LazyLock<ConsumerSpec>=std::sync::LazyLock::new(||
            serde_json::from_str(include_str!("../consumers/alpamayo-r1.json")).expect("embedded Alpamayo contract"));
        SPEC.clone()
    }
    pub fn validate(&self)->Result<(),String> {
        if self.width==0 || self.height==0 || !self.camera_hz.is_finite() || self.camera_hz<=0.0 {
            return Err("consumer dimensions and cameraHz must be positive".into());
        }
        if self.name.is_empty() || self.camera_history_frames==0 || self.camera_history_frames>64
            || [self.ego_history,self.future_target].iter().any(|s| s.points==0 || s.points>1000 || !s.hz.is_finite() || s.hz<=0.0) {
            return Err("consumer requires a name, 1..64 image timestamps and finite positive trajectory sampling (1..1000 points)".into());
        }
        match self.rgb {
            RgbProduct::Jpeg {quality} if !(1..=100).contains(&quality)=>return Err("JPEG quality must be 1..100".into()),
            RgbProduct::Video {quality,..} if quality>51 || self.width%2!=0 || self.height%2!=0=>return Err("video needs even dimensions and quality 0..51".into()),
            _=>{}
        }
        if let Some(DepthProduct::MetricAxial {scale})=self.depth {
            if !(1..=16).contains(&scale) || self.width%scale!=0 || self.height%scale!=0 {
                return Err("metric depth needs a scale 1..16 dividing both dimensions".into());
            }
        }
        if self.occupancy && self.lidar.is_none() {return Err("occupancy requires a lidar return product".into());}
        Ok(())
    }
    pub fn video(&self)->bool {matches!(self.rgb,RgbProduct::Video {..})}
    pub fn rgb_format(&self)->&'static str {match self.rgb {RgbProduct::Png=>"png",RgbProduct::Jpeg {..}=>"jpeg",RgbProduct::Video {..}=>"video"}}
    pub fn jpeg_quality(&self)->u8 {match self.rgb {RgbProduct::Jpeg {quality}=>quality,_=>90}}
    pub fn video_encoder(&self)->&'static str {match self.rgb {RgbProduct::Video {encoder,..}=>encoder.as_str(),_=>"x264"}}
    pub fn video_quality(&self)->u32 {match self.rgb {RgbProduct::Video {quality,..}=>quality,_=>18}}
    pub fn depth_format(&self)->&'static str {match self.depth {Some(DepthProduct::ReverseZ32)=>"f32",Some(DepthProduct::ReverseZ16)=>"f16",Some(DepthProduct::MetricAxial {..})=>"metric-f16",None=>"none"}}
    pub fn depth_scale(&self)->u32 {match self.depth {Some(DepthProduct::MetricAxial {scale})=>scale,_=>4}}
}
