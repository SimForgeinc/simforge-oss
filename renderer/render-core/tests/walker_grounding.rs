//! Every catalog walker stands on its soles, not in the ground.
//!
//! The service puts a walker's model origin on the simulator's ground point
//! plus the catalog's measured lift for the clip it plays
//! (`VehicleModelEntry::ground_offset_for`). This poses each pedestrian GLB
//! straight from its glTF data (node TRS, LINEAR/STEP channels with slerped
//! rotations, 4-influence linear blend skinning), independent of the tool that
//! measured the lift, across its idle and walk cycles, and requires:
//!
//! - the stance sole (the median over the cycle of each pose's lowest vertex)
//!   within 1 cm of the ground: neither sunk (the child walkers once stood
//!   27 cm deep) nor floating;
//! - no pose more than 6 cm into or above the ground. A constant lift cannot
//!   hold every pose of a gait at zero: hips bob and heel strike dips a few
//!   frames below the stance (worst measured: 5.7 cm, the G3 walk).

use std::collections::HashMap;
use std::path::Path;

use bevy::math::{Mat4, Quat, Vec3, Vec4};
use gltf::animation::util::ReadOutputs;
use gltf::animation::Interpolation;
use render_core::vehicle_model::VehicleModelCatalog;

const STANCE_TOLERANCE_M: f32 = 0.01;
const GAIT_SPREAD_M: f32 = 0.06;
/// Samples per clip (every keyframe up to this many, evenly strided beyond).
const MAX_SAMPLES: usize = 96;

struct Channel {
    node: usize,
    times: Vec<f32>,
    values: Values,
    step: bool,
}

enum Values {
    Translation(Vec<Vec3>),
    Rotation(Vec<Quat>),
    Scale(Vec<Vec3>),
}

struct Primitive {
    skin: usize,
    positions: Vec<Vec4>,
    joints: Vec<[u16; 4]>,
    weights: Vec<[f32; 4]>,
}

struct Walker {
    rest: Vec<(Vec3, Quat, Vec3)>,
    parent: Vec<Option<usize>>,
    skins: Vec<(Vec<usize>, Vec<Mat4>)>,
    primitives: Vec<Primitive>,
    clips: HashMap<String, Vec<Channel>>,
}

impl Walker {
    fn load(path: &Path) -> Walker {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let gltf = gltf::Gltf::from_slice(&bytes).unwrap();
        let blob = gltf.blob.as_deref().expect("self-contained GLB");
        let buffers = |_: gltf::Buffer| Some(blob);
        let doc = &gltf.document;
        let mut parent = vec![None; doc.nodes().len()];
        for node in doc.nodes() {
            for child in node.children() {
                parent[child.index()] = Some(node.index());
            }
        }
        let rest = doc
            .nodes()
            .map(|node| {
                let (t, r, s) = node.transform().decomposed();
                (Vec3::from(t), Quat::from_array(r), Vec3::from(s))
            })
            .collect();
        let skins = doc
            .skins()
            .map(|skin| {
                let joints: Vec<usize> = skin.joints().map(|j| j.index()).collect();
                let ibms = skin
                    .reader(buffers)
                    .read_inverse_bind_matrices()
                    .expect("inverse bind matrices")
                    .map(|m| Mat4::from_cols_array_2d(&m))
                    .collect();
                (joints, ibms)
            })
            .collect();
        let mut primitives = Vec::new();
        for node in doc.nodes() {
            let Some(mesh) = node.mesh() else { continue };
            let skin = node
                .skin()
                .unwrap_or_else(|| {
                    panic!(
                        "{}: mesh node {:?} is not skinned",
                        path.display(),
                        node.name()
                    )
                })
                .index();
            for primitive in mesh.primitives() {
                let reader = primitive.reader(buffers);
                primitives.push(Primitive {
                    skin,
                    positions: reader
                        .read_positions()
                        .unwrap()
                        .map(|p| Vec3::from(p).extend(1.0))
                        .collect(),
                    joints: reader.read_joints(0).unwrap().into_u16().collect(),
                    weights: reader.read_weights(0).unwrap().into_f32().collect(),
                });
            }
        }
        let mut clips = HashMap::new();
        for animation in doc.animations() {
            let channels = animation
                .channels()
                .map(|channel| {
                    let reader = channel.reader(buffers);
                    let times: Vec<f32> = reader.read_inputs().unwrap().collect();
                    let step = channel.sampler().interpolation() == Interpolation::Step;
                    assert_ne!(
                        channel.sampler().interpolation(),
                        Interpolation::CubicSpline
                    );
                    let values = match reader.read_outputs().unwrap() {
                        ReadOutputs::Translations(v) => {
                            Values::Translation(v.map(Vec3::from).collect())
                        }
                        ReadOutputs::Rotations(v) => {
                            Values::Rotation(v.into_f32().map(Quat::from_array).collect())
                        }
                        ReadOutputs::Scales(v) => Values::Scale(v.map(Vec3::from).collect()),
                        ReadOutputs::MorphTargetWeights(_) => panic!("unexpected morph channel"),
                    };
                    Channel {
                        node: channel.target().node().index(),
                        times,
                        values,
                        step,
                    }
                })
                .collect();
            clips.insert(animation.name().unwrap_or_default().to_string(), channels);
        }
        Walker {
            rest,
            parent,
            skins,
            primitives,
            clips,
        }
    }

    fn sample_times(&self, clip: &str) -> Vec<f32> {
        let mut keys: Vec<f32> = self.clips[clip]
            .iter()
            .flat_map(|c| c.times.iter().copied())
            .collect();
        keys.sort_by(f32::total_cmp);
        keys.dedup();
        let stride = keys.len().div_ceil(MAX_SAMPLES).max(1);
        keys.into_iter().step_by(stride).collect()
    }

    /// Lowest posed vertex height at `time_s` of `clip`, in model space.
    fn lowest(&self, clip: &str, time_s: f32) -> f32 {
        let mut local = self.rest.clone();
        for channel in &self.clips[clip] {
            let times = &channel.times;
            let t = time_s.clamp(times[0], times[times.len() - 1]);
            let k = times
                .partition_point(|&x| x <= t)
                .saturating_sub(1)
                .min(times.len() - 1);
            let (next, f) = if channel.step || k + 1 == times.len() {
                (k, 0.0)
            } else {
                (k + 1, (t - times[k]) / (times[k + 1] - times[k]))
            };
            let pose = &mut local[channel.node];
            match &channel.values {
                Values::Translation(v) => pose.0 = v[k].lerp(v[next], f),
                Values::Rotation(v) => pose.1 = v[k].normalize().slerp(v[next].normalize(), f),
                Values::Scale(v) => pose.2 = v[k].lerp(v[next], f),
            }
        }
        let mut world: Vec<Option<Mat4>> = vec![None; local.len()];
        fn resolve(
            i: usize,
            local: &[(Vec3, Quat, Vec3)],
            parent: &[Option<usize>],
            world: &mut [Option<Mat4>],
        ) -> Mat4 {
            if let Some(m) = world[i] {
                return m;
            }
            let (t, r, s) = local[i];
            let own = Mat4::from_scale_rotation_translation(s, r, t);
            let m = match parent[i] {
                Some(p) => resolve(p, local, parent, world) * own,
                None => own,
            };
            world[i] = Some(m);
            m
        }
        let mut low = f32::INFINITY;
        for primitive in &self.primitives {
            let (joints, ibms) = &self.skins[primitive.skin];
            // Only the posed height is needed: row 1 of each joint matrix.
            let rows: Vec<Vec4> = joints
                .iter()
                .zip(ibms)
                .map(|(&j, ibm)| (resolve(j, &local, &self.parent, &mut world) * *ibm).row(1))
                .collect();
            for ((p, j), w) in primitive
                .positions
                .iter()
                .zip(&primitive.joints)
                .zip(&primitive.weights)
            {
                let y: f32 = (0..4).map(|k| w[k] * rows[j[k] as usize].dot(*p)).sum();
                low = low.min(y);
            }
        }
        low
    }
}

#[test]
fn every_catalog_walker_stands_on_its_soles_across_idle_and_walk() {
    let pack = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../catalog/pedestrians-carla");
    let catalog = VehicleModelCatalog::load(&pack).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(pack.join("manifest.json")).unwrap()).unwrap();
    let walkers = manifest["pedestrians"].as_object().unwrap();
    assert_eq!(walkers.len(), 38);
    let mut failures = Vec::new();
    let mut children = 0;
    for (id, item) in walkers {
        let entry = catalog
            .resolve(id)
            .unwrap_or_else(|| panic!("{id} is not in the sidecar"));
        let walker = Walker::load(&entry.glb_path);
        children += usize::from(item["age"] == "child");
        for (motion, (glb, clip)) in &entry.animations {
            assert_eq!(
                glb, &entry.glb_path,
                "{id} {motion}: clips are authored into the model"
            );
            let lift = entry.ground_offset_for(Some(motion)).unwrap();
            let mut samples: Vec<f32> = walker
                .sample_times(clip)
                .into_iter()
                .map(|t| walker.lowest(clip, t) + lift)
                .collect();
            samples.sort_by(f32::total_cmp);
            let stance = samples[samples.len() / 2];
            let (deepest, highest) = (samples[0], samples[samples.len() - 1]);
            if stance.abs() > STANCE_TOLERANCE_M
                || deepest < -GAIT_SPREAD_M
                || highest > GAIT_SPREAD_M
            {
                failures.push(format!(
                    "{id} ({}) {motion}: stance sole {:+.1} cm, poses {:+.1}..{:+.1} cm from the ground over {} samples (lift {:.3} m)",
                    item["age"],
                    stance * 100.0,
                    deepest * 100.0,
                    highest * 100.0,
                    samples.len(),
                    lift
                ));
            }
        }
        assert!(
            entry.animations.contains_key("idle") && entry.animations.contains_key("walk"),
            "{id}"
        );
    }
    assert_eq!(children, 4, "the pack's four child walkers are covered");
    assert!(
        failures.is_empty(),
        "walkers off the ground:\n{}",
        failures.join("\n")
    );
}
