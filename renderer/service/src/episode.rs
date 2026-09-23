//! Caller-clocked episodes. The socket dispatch owns the only simulation clock.
use crate::scene::{ActorDims, ActorState, ActorTransform, SceneState};
use render_core::scene_state::{ActorTickKind, SceneState as Document};
use serde::{Deserialize, Serialize};

/// Commands are held constant for one declared consumer interval (2 or 10 Hz, e.g.).
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Bicycle { acceleration_mps2: f64, steering_rad: f64 },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeObservation {
    pub tick: u32,
    pub time_seconds: f64,
    pub ego_id: String,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub velocity: [f32; 3],
    pub source_exhausted: bool,
    pub traffic_mode: &'static str,
    pub replay_valid: bool,
    pub replay_divergence_m: f64,
    pub replay_tube_m: f64,
    pub ego_history: Trajectory,
    /// Privileged authored supervision, NOT a prediction or policy input.
    pub reference_future: Trajectory,
    pub termination: Option<Termination>,
    pub score: f64,
    pub score_valid: bool,
    pub progress: f64,
    pub wheelbase_m: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EpisodeLimits {
    pub wheelbase_m: f64,
    pub timeout_seconds: f64,
    pub goal_radius_m: f64,
}
impl Default for EpisodeLimits {
    fn default() -> Self { Self {wheelbase_m:2.7, timeout_seconds:20.0, goal_radius_m:1.0} }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag="reason",rename_all="snake_case")]
pub enum Termination { ReplayInvalid, Collision {actor_id:String}, OffRoad, GoalReached, Timeout }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trajectory {
    pub frame: &'static str,
    pub poses: Vec<[f64; 3]>,
    pub velocity: Vec<[f64; 2]>,
    pub acceleration: Vec<[f64; 2]>,
    pub valid: Vec<bool>,
    pub acceleration_valid: Vec<bool>,
}

#[derive(Clone, Copy)]
struct MotionSample { index: usize, vehicle: crate::dynamics::Bicycle, acceleration: [f64; 2] }

pub struct Episode {
    pub authored: Vec<SceneState>,
    pub index: usize,
    pub ego_id: String,
    stride: usize,
    pub wheelbase_m: f64,
    pub vehicle: crate::dynamics::Bicycle,
    pub replay_divergence_m: f64,
    pub replay_valid: bool,
    history: Vec<MotionSample>,
    limits: EpisodeLimits,
    pub termination: Option<Termination>,
    goal: [f64; 2],
    initial_goal_distance: f64,
    pub consumer: render_core::products::ConsumerSpec,
    start_index: usize,
}

impl Episode {
    pub fn reset(document: Document, ego_id: String, limits: EpisodeLimits) -> Result<Self, String> {
        document.validate().map_err(|e| e.to_string())?;
        if ![limits.wheelbase_m,limits.timeout_seconds,limits.goal_radius_m].iter().all(|v| v.is_finite() && *v>0.0) {
            return Err("episode limits must be finite and positive".into());
        }
        let hz = document.tick_hz;
        if !hz.is_finite() || hz < 10.0 || (hz / 10.0 - (hz / 10.0).round()).abs() > 1e-9 {
            return Err("episode requires a finite source rate divisible by 10 Hz".into());
        }
        if document.frames.is_empty() || document.frames.windows(2).any(|w| w[1].tick != w[0].tick + 1) {
            return Err("episode requires a nonempty, contiguous source interval".into());
        }
        let mut authored = Vec::with_capacity(document.frames.len());
        // Odometer per actor, the render timeline's `wheelSpinRad` rule over this
        // contiguous source interval: Σ signed speed·dt on ticks after spawn. It phases
        // ridden two-wheelers deterministically from the document alone.
        let mut odometer: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
        for frame in &document.frames {
            let mut actors = Vec::with_capacity(frame.actors.len());
            for pose in &frame.actors {
                let desc = document.actors.iter().find(|a| a.id == pose.id)
                    .ok_or_else(|| format!("actor {} has no declaration", pose.id))?;
                if pose.position.iter().chain(pose.velocity.iter()).any(|v| !v.is_finite()) {
                    return Err(format!("actor {} has nonfinite state", pose.id));
                }
                if !desc.dims.is_some_and(|d| [d.l,d.w,d.h].iter().all(|v| v.is_finite() && *v>0.0)) {
                    return Err(format!("actor {} requires positive declared dimensions for collision/replay checks",pose.id));
                }
                let distance = odometer.entry(pose.id.clone()).or_insert(0.0);
                if matches!(pose.kind, ActorTickKind::Update) {
                    // Signed like the timeline's speed: travelling rear-first
                    // (velocity against the body's +X) runs the odometer back.
                    let [x, y, z, w] = pose.rotation;
                    let forward = [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w)];
                    let along: f64 = pose.velocity.iter().zip(forward).map(|(v, f)| v * f).sum();
                    let speed = pose.velocity.iter().map(|v| v * v).sum::<f64>().sqrt();
                    *distance += if along < 0.0 { -speed } else { speed } / hz;
                }
                // The document's own timeline channel when it carries one; an
                // episode document without it gets the same rule derived here.
                let wheel_spin_rad = match pose.wheel_spin_rad {
                    Some(spin) => Some(spin),
                    None => Some(*distance / render_core::vehicle_model::TIMELINE_WHEEL_RADIUS_M),
                };
                actors.push(ActorState {
                    id: pose.id.clone(),
                    kind: match pose.kind { ActorTickKind::Spawn => "spawn", ActorTickKind::Update => "update", ActorTickKind::Despawn => "despawn" }.into(),
                    catalog_id: Some(desc.catalog_id.clone()), actor_class: Some(desc.actor_class.clone()),
                    color: desc.color.clone(), dims: desc.dims.map(|d| ActorDims { l: d.l as f32, w: d.w as f32, h: d.h as f32 }),
                    transform: ActorTransform { position: pose.position.map(|v| v as f32), rotation: pose.rotation.map(|v| v as f32) },
                    velocity: pose.velocity.map(|v| v as f32),
                    wheel_spin_rad,
                    body_attitude: pose.body_attitude.map(|a| crate::scene::BodyAttitude { pitch_rad: a.pitch_rad as f32, roll_rad: a.roll_rad as f32 }),
                    wheel_drop_m: pose.wheel_drop_m.map(|d| d.map(|v| v as f32)),
                });
            }
            if !actors.iter().any(|a| a.id == ego_id && a.kind != "despawn") {
                return Err(format!("ego {ego_id} missing at tick {}", frame.tick));
            }
            authored.push(SceneState {
                version: document.version.clone(), map_id: document.map_id.clone(), tick: frame.tick,
                tick_hz: hz as f32, weather: None, time_of_day: Some(document.time_of_day as f32),
                ground_y: document.ground_y.map(|v| v as f32), actors,
            });
        }
        let ego = authored[0].actors.iter().find(|a| a.id == ego_id).unwrap();
        let q = ego.transform.rotation;
        let yaw = (2.0*(q[3]*q[1]+q[2]*q[0])).atan2(1.0-2.0*(q[1]*q[1]+q[2]*q[2]));
        let vehicle = crate::dynamics::Bicycle { x: ego.transform.position[0] as f64,
            z: ego.transform.position[2] as f64, yaw: yaw as f64,
            speed: (ego.velocity[0] as f64).hypot(ego.velocity[2] as f64) };
        let end=authored.last().unwrap().actors.iter().find(|a| a.id==ego_id).unwrap().transform.position;
        let goal=[end[0] as f64,end[2] as f64];
        let initial_goal_distance=(vehicle.x-goal[0]).hypot(vehicle.z-goal[1]);
        Ok(Self { authored, index: 0, ego_id, stride: (hz / 2.0).round() as usize, wheelbase_m: limits.wheelbase_m,
            vehicle, replay_divergence_m: 0.0, replay_valid: true,
            history: vec![MotionSample { index:0, vehicle, acceleration:[0.0;2] }],
            limits,termination:None,goal,initial_goal_distance,start_index:0,
            consumer:render_core::products::OutputMode::Training.consumer() })
    }

    pub fn configure_consumer(&mut self, consumer: render_core::products::ConsumerSpec)->Result<(),String> {
        consumer.validate()?;
        let hz=self.authored[0].tick_hz as f64;
        for rate in [consumer.camera_hz,consumer.ego_history.hz,consumer.future_target.hz] {
            if rate>hz || (hz/rate-(hz/rate).round()).abs()>1e-6 {
                return Err("consumer sample rates must divide the scenario physics rate".into());
            }
        }
        self.stride=(hz/consumer.camera_hz).round() as usize;
        self.consumer=consumer;
        Ok(())
    }

    /// Authored pre-roll initializes known history before policy control begins.
    /// It is never scored as policy driving. Returns RGB history source indices.
    pub fn warm_start(&mut self)->Result<Vec<usize>,String> {
        let hz=self.authored[0].tick_hz as f64;
        let image_span=(self.consumer.camera_history_frames-1) as f64/self.consumer.camera_hz;
        let ego_span=(self.consumer.ego_history.points-1) as f64/self.consumer.ego_history.hz;
        let index=(image_span.max(ego_span)*hz).round() as usize;
        if index+1>=self.authored.len() {return Err("scenario too short for declared observation history and one controlled tick".into());}
        self.history.clear();
        for i in 0..=index {
            let actor=self.authored[i].actors.iter().find(|a| a.id==self.ego_id).unwrap();
            let pose=footprint(actor);
            let previous=self.authored[i.saturating_sub(1)].actors.iter().find(|a| a.id==self.ego_id).unwrap();
            let vehicle=crate::dynamics::Bicycle {x:pose.x,z:pose.z,yaw:pose.yaw,
                speed:(actor.velocity[0] as f64).hypot(actor.velocity[2] as f64)};
            self.history.push(MotionSample {index:i,vehicle,
                acceleration:[(actor.velocity[0]-previous.velocity[0]) as f64*hz,(actor.velocity[2]-previous.velocity[2]) as f64*hz]});
        }
        self.vehicle=self.history.last().unwrap().vehicle;
        self.index=index;self.start_index=index;
        self.initial_goal_distance=(self.vehicle.x-self.goal[0]).hypot(self.vehicle.z-self.goal[1]);
        Ok((0..self.consumer.camera_history_frames as usize).map(|n|
            index-(self.consumer.camera_history_frames as usize-1-n)*self.stride).collect())
    }

    pub fn advance(&mut self, action: Action, drivable: impl Fn(crate::traffic::Footprint)->bool) -> Result<SceneState, String> {
        if self.termination.is_some() { return Err("episode terminated; reset required".into()); }
        let Action::Bicycle { acceleration_mps2, steering_rad } = action;
        let dt=1.0/self.authored[0].tick_hz as f64;
        // Validate the action before mutating the episode.
        let mut check=self.vehicle;
        check.integrate(acceleration_mps2,steering_rad,self.wheelbase_m,dt)?;
        for _ in 0..self.stride.min(self.authored.len()-1-self.index) {
            let previous=self.vehicle;
            self.vehicle.integrate(acceleration_mps2,steering_rad,self.wheelbase_m,dt)?;
            self.index+=1;
            let authored=self.authored[self.index].actors.iter().find(|a| a.id==self.ego_id).unwrap();
            let baseline=footprint(authored);
            let acceleration=[(self.vehicle.speed*self.vehicle.yaw.cos()-previous.speed*previous.yaw.cos())/dt,
                (-self.vehicle.speed*self.vehicle.yaw.sin()+previous.speed*previous.yaw.sin())/dt];
            self.history.push(MotionSample {index:self.index,vehicle:self.vehicle,acceleration});
            let actual=crate::traffic::Footprint {x:self.vehicle.x,z:self.vehicle.z,yaw:self.vehicle.yaw,..baseline};
            self.replay_divergence_m=actual.divergence(baseline);
            self.replay_valid=self.replay_divergence_m<=crate::traffic::REPLAY_TUBE_M;
            self.evaluate(&drivable);
            if self.termination.is_some() { break; }
        }
        let mut frame=self.authored[self.index].clone();
        let ego=frame.actors.iter_mut().find(|a| a.id==self.ego_id).unwrap();
        let vehicle=self.vehicle;
        ego.transform.position[0]=vehicle.x as f32;
        ego.transform.position[2]=vehicle.z as f32;
        ego.transform.rotation=[0.0,(vehicle.yaw*0.5).sin() as f32,0.0,(vehicle.yaw*0.5).cos() as f32];
        ego.velocity=[(vehicle.speed*vehicle.yaw.cos()) as f32,0.0,(-vehicle.speed*vehicle.yaw.sin()) as f32];
        Ok(frame)
    }

    /// Called at reset and every physics substep, not just the camera cadence.
    pub fn evaluate(&mut self, drivable: &impl Fn(crate::traffic::Footprint)->bool) {
        let frame=&self.authored[self.index];
        let ego=frame.actors.iter().find(|a| a.id==self.ego_id).unwrap();
        let actual=crate::traffic::Footprint {x:self.vehicle.x,z:self.vehicle.z,yaw:self.vehicle.yaw,..footprint(ego)};
        self.termination=if !self.replay_valid {
            Some(Termination::ReplayInvalid)
        } else if let Some(other)=frame.actors.iter().find(|a| a.id!=self.ego_id && a.kind!="despawn" && actual.separation(footprint(a))<=0.0) {
            Some(Termination::Collision {actor_id:other.id.clone()})
        } else if !drivable(actual) {Some(Termination::OffRoad)
        } else if (self.vehicle.x-self.goal[0]).hypot(self.vehicle.z-self.goal[1])<=self.limits.goal_radius_m && self.vehicle.speed<=0.5 {
            Some(Termination::GoalReached)
        } else if self.index+1==self.authored.len() || (self.index-self.start_index) as f64/frame.tick_hz as f64>=self.limits.timeout_seconds {
            Some(Termination::Timeout)
        } else {None};
    }

    fn progress(&self) -> f64 {
        if self.initial_goal_distance<1e-6 { return f64::from(matches!(self.termination,Some(Termination::GoalReached))); }
        (1.0-(self.vehicle.x-self.goal[0]).hypot(self.vehicle.z-self.goal[1])/self.initial_goal_distance).clamp(0.0,1.0)
    }

    fn trajectory(&self, future: bool) -> Trajectory {
        let mut out=Trajectory {frame:"actor-origin x-forward/y-left; heading positive left",
            poses:Vec::new(),velocity:Vec::new(),acceleration:Vec::new(),valid:Vec::new(),acceleration_valid:Vec::new()};
        let samples=if future {self.consumer.future_target} else {self.consumer.ego_history};
        let stride=(self.authored[0].tick_hz/samples.hz as f32).round() as isize;
        let (s,c)=self.vehicle.yaw.sin_cos();
        let rotate=|x:f64,z:f64| [c*x-s*z,-s*x-c*z];
        let offsets=if future {1..=samples.points as isize} else {1-samples.points as isize..=0};
        for offset in offsets {
            let index=self.index as isize+offset*stride;
            let sample=if index<0 {None} else if future {
                self.authored.get(index as usize).and_then(|frame| frame.actors.iter().find(|a| a.id==self.ego_id))
                    .map(|actor| {
                        let pose=footprint(actor);
                        let previous=self.authored[index as usize-1].actors.iter().find(|a| a.id==self.ego_id).unwrap();
                        let hz=self.authored[0].tick_hz as f64;
                        MotionSample {index:index as usize,
                            vehicle:crate::dynamics::Bicycle {x:pose.x,z:pose.z,yaw:pose.yaw,
                                speed:(actor.velocity[0] as f64).hypot(actor.velocity[2] as f64)},
                            acceleration:[(actor.velocity[0]-previous.velocity[0]) as f64*hz,
                                (actor.velocity[2]-previous.velocity[2]) as f64*hz]} })
            } else {self.history.get(index as usize).copied()};
            out.valid.push(sample.is_some());
            out.acceleration_valid.push(sample.is_some_and(|s| s.index>0));
            if let Some(sample)=sample {
                let v=sample.vehicle;
                let p=rotate(v.x-self.vehicle.x,v.z-self.vehicle.z);
                let angle=v.yaw-self.vehicle.yaw;
                out.poses.push([p[0],p[1],angle.sin().atan2(angle.cos())]);
                out.velocity.push(rotate(v.speed*v.yaw.cos(),-v.speed*v.yaw.sin()));
                out.acceleration.push(rotate(sample.acceleration[0],sample.acceleration[1]));
            } else {
                out.poses.push([0.0;3]);out.velocity.push([0.0;2]);out.acceleration.push([0.0;2]);
            }
        }
        out
    }

    pub fn observe(&self, frame: &SceneState) -> EpisodeObservation {
        let ego = frame.actors.iter().find(|a| a.id == self.ego_id).unwrap();
        EpisodeObservation {
            tick: frame.tick, time_seconds: frame.tick as f64 / frame.tick_hz as f64,
            ego_id: self.ego_id.clone(), position: ego.transform.position,
            rotation: ego.transform.rotation, velocity: ego.velocity,
            source_exhausted: self.index + self.stride >= self.authored.len(),
            traffic_mode: "replay_with_divergence_guard",
            replay_valid: self.replay_valid,
            replay_divergence_m: self.replay_divergence_m,
            replay_tube_m: crate::traffic::REPLAY_TUBE_M,
            ego_history: self.trajectory(false),
            reference_future: self.trajectory(true),
            termination:self.termination.clone(),
            score:match self.termination {Some(Termination::GoalReached)=>100.0,
                Some(Termination::Collision {..}|Termination::OffRoad|Termination::ReplayInvalid)=>0.0,
                _=>100.0*self.progress()},
            score_valid:self.replay_valid,
            progress:self.progress(),
            wheelbase_m:self.wheelbase_m,
        }
    }
}

pub fn footprint(actor: &ActorState) -> crate::traffic::Footprint {
    let q=actor.transform.rotation;
    let dims=actor.dims.expect("episode actors require declared extents");
    crate::traffic::Footprint {x:actor.transform.position[0] as f64,z:actor.transform.position[2] as f64,
        yaw:(2.0*(q[3]*q[1]+q[2]*q[0])).atan2(1.0-2.0*(q[1]*q[1]+q[2]*q[2])) as f64,
        length:dims.l as f64,width:dims.w as f64}
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn fixture(other: bool) -> Document {
        let mut actors=vec![serde_json::json!({"id":"ego","catalogId":"car","actorClass":"car","dims":{"l":2.0,"w":1.0,"h":1.0}})];
        if other {actors.push(serde_json::json!({"id":"other","catalogId":"car","actorClass":"car","dims":{"l":2.0,"w":1.0,"h":1.0}}));}
        let frames:Vec<_>=(0..=100).map(|tick| {
            let mut poses=vec![serde_json::json!({"id":"ego","kind":"update","position":[tick as f64/50.0,0,0],"rotation":[0,0,0,1],"yawRad":0,"velocity":[1,0,0]})];
            if other {poses.push(serde_json::json!({"id":"other","kind":"update","position":[2.5,0,0],"rotation":[0,0,0,1],"yawRad":0,"velocity":[0,0,0]}));}
            serde_json::json!({"tick":tick,"t":tick as f64/50.0,"actors":poses})
        }).collect();
        serde_json::from_value(serde_json::json!({"version":"simforge.scene-state.v1","mapId":"fixture",
            "frame":"scene-yup","dt":0.02,"tickHz":50,"tickCount":101,"weather":{"preset":"clear"},
            "timeOfDay":12,"actors":actors,"frames":frames})).unwrap()
    }
    fn straight() -> Action {Action::Bicycle {acceleration_mps2:0.0,steering_rad:0.0}}

    #[test]
    fn termination_checks_substeps_and_blocks_post_terminal_actions() {
        let mut collision=Episode::reset(fixture(true),"ego".into(),EpisodeLimits::default()).unwrap();
        let frame=collision.advance(straight(), |_|true).unwrap();
        let result=collision.observe(&frame);
        assert_eq!(result.termination,Some(Termination::Collision {actor_id:"other".into()}));
        assert_eq!(result.score,0.0);
        assert!(collision.advance(straight(), |_|true).is_err());
        let mut road=Episode::reset(fixture(false),"ego".into(),EpisodeLimits::default()).unwrap();
        let frame=road.advance(straight(), |p|p.x<0.11).unwrap();
        assert_eq!(road.observe(&frame).termination,Some(Termination::OffRoad));
        assert_eq!(frame.tick,6); // 120 ms, not the 500 ms camera boundary.
        let mut timeout=Episode::reset(fixture(false),"ego".into(),EpisodeLimits {timeout_seconds:0.2,..Default::default()}).unwrap();
        let frame=timeout.advance(straight(), |_|true).unwrap();
        let result=timeout.observe(&frame);
        assert_eq!(result.termination,Some(Termination::Timeout));
        assert!((result.score-10.0).abs()<1e-8 && result.score_valid);
    }

    #[test]
    fn diverging_arc_is_invalid_replay_not_a_policy_collision() {
        let mut episode=Episode::reset(fixture(false),"ego".into(),EpisodeLimits::default()).unwrap();
        let frame=episode.advance(Action::Bicycle {acceleration_mps2:5.0,steering_rad:0.7}, |_|true).unwrap();
        let result=episode.observe(&frame);
        assert_eq!(result.termination,Some(Termination::ReplayInvalid));
        assert!(!result.score_valid && result.replay_divergence_m>0.5);
        assert_eq!(result.score,0.0);
    }

    #[test]
    fn goal_and_history_do_not_leak_future_or_invent_past() {
        let mut episode=Episode::reset(fixture(false),"ego".into(),EpisodeLimits::default()).unwrap();
        let initial=episode.observe(&episode.authored[0]);
        assert_eq!(initial.ego_history.valid.iter().filter(|v|**v).count(),1);
        assert_eq!(initial.reference_future.valid.iter().filter(|v|**v).count(),20);
        for _ in 0..3 {episode.advance(straight(), |_|true).unwrap();}
        let observation=episode.observe(&episode.authored[episode.index]);
        assert!(observation.ego_history.valid.iter().all(|v|*v));
        assert!((observation.ego_history.poses[0][0]+1.5).abs()<1e-8);
        episode.vehicle.x=2.0;episode.vehicle.speed=0.0;
        episode.evaluate(&|_|true);
        assert_eq!(episode.termination,Some(Termination::GoalReached));
    }
}

#[cfg(test)]
mod temporal_tests {
    use super::*;
    #[test]
    fn named_consumers_have_distinct_real_history_and_control_cadence() {
        for (consumer,expected,next) in [
            (render_core::products::ConsumerSpec::qwen_drive(),vec![0,25,50,75],100),
            (render_core::products::ConsumerSpec::alpamayo_r1(),vec![60,65,70,75],80),
        ] {
            let mut episode=Episode::reset(super::tests::fixture(false),"ego".into(),EpisodeLimits::default()).unwrap();
            episode.configure_consumer(consumer).unwrap();
            assert_eq!(episode.warm_start().unwrap(),expected);
            let initial=episode.observe(&episode.authored[episode.index]);
            assert!(initial.ego_history.valid.iter().all(|v|*v));
            assert!((initial.ego_history.poses[0][0]+1.5).abs()<1e-6);
            let frame=episode.advance(Action::Bicycle {acceleration_mps2:0.0,steering_rad:0.0}, |_|true).unwrap();
            assert_eq!(frame.tick,next);
        }
    }
}
