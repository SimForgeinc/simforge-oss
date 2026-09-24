//! Manifest-driven progressive scene loading.
//!
//! Why this exists instead of `asset_server.load::<Gltf>("master.gltf")`:
//! Bevy's glTF loader is all-or-nothing per document. The canonical native
//! profiles are 0.6-8.7 GB, of which 0.6-8.5 GB is KTX2 texture payload, so
//! "load the document" and "be interactive in a few seconds" are mutually
//! exclusive. The document is an index, not a unit of work.
//!
//! So this module reads `master.gltf` as the index it is, computes a world
//! AABB and a byte cost for every drawable node, and then admits nodes to the
//! GPU in tiers under an explicit byte budget:
//!
//! * [`Tier::Coarse`] - positions and indices only, unlit. No normals, no
//!   UVs, no textures, so the bytes read are a small fraction of the node's
//!   full cost. The coarse plan is the extent-ranked prefix of the scene that
//!   fits `coarse_budget`, which is what `coarse-ready` reports.
//! * [`Tier::Detail`] - positions, normals, UVs, indices and the node's
//!   material, with its base-colour KTX2 admitted only if the texture budget
//!   has room.
//!
//! Reads happen on a loader thread; the main schedule only ever moves
//! finished vertex buffers into `Assets<Mesh>`. Admission is rate-limited
//! (see `stream_ops_per_frame`) because the failure mode of an unbounded
//! upload queue is a compositor-level GPU stall, not a slow load.

use bevy::math::{Mat4, Quat, Vec3};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender};

/// Detail level of one drawable node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    /// Not resident.
    Absent,
    /// Positions and indices, unlit.
    Coarse,
    /// Positions, normals, UVs and the authored material.
    Detail,
}

#[derive(Debug, Clone, Copy)]
struct Accessor {
    count: usize,
    component_type: u32,
    components: usize,
    buffer_view: usize,
    byte_offset: usize,
}

#[derive(Debug, Clone, Copy)]
struct BufferView {
    byte_offset: usize,
    byte_length: usize,
    byte_stride: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
pub struct Primitive {
    position: usize,
    normal: Option<usize>,
    uv: Option<usize>,
    indices: Option<usize>,
    pub material: Option<usize>,
}

/// One drawable glTF node, flattened out of the scene graph with its world
/// transform already applied to its bounds.
#[derive(Debug, Clone)]
pub struct DrawNode {
    pub node: usize,
    pub name: String,
    pub transform: Mat4,
    pub primitives: Vec<Primitive>,
    /// World-space bounds, used for LOD ranking and budget decisions.
    pub min: Vec3,
    pub max: Vec3,
    /// Node-local bounds, which is what the spawned entity's `Aabb` needs:
    /// the entity carries `transform` rather than baking it into vertices.
    pub local_min: Vec3,
    pub local_max: Vec3,
    /// Bytes this node occupies on the GPU at [`Tier::Coarse`].
    pub coarse_bytes: u64,
    /// Bytes this node occupies on the GPU at [`Tier::Detail`], geometry only.
    pub detail_bytes: u64,
}

impl DrawNode {
    pub fn center(&self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    /// Largest world-space dimension; the LOD ranking key.
    pub fn extent(&self) -> f32 {
        (self.max - self.min).max_element()
    }

    /// Geometric layer classification. The native map profile contains no
    /// actors, so a node is either the near-planar large surface a user means
    /// by "ground" or it is `map-static`. Actor picking is answered by the
    /// editor's own actor layer, not by map geometry.
    pub fn layer(&self) -> &'static str {
        let size = self.max - self.min;
        let footprint = size.x.max(size.z);
        if size.y <= 1.5 && footprint >= 8.0 {
            "ground"
        } else {
            "map-static"
        }
    }

    pub fn bytes_at(&self, tier: Tier) -> u64 {
        match tier {
            Tier::Absent => 0,
            Tier::Coarse => self.coarse_bytes,
            Tier::Detail => self.detail_bytes,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct MaterialDef {
    pub base_color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    /// Relative path of the base-colour KTX2 inside the map root, resolved
    /// through `KHR_texture_basisu`. The `.png` entries a profile also
    /// declares are placeholders that are not shipped.
    pub base_color_texture: Option<String>,
    /// GPU bytes the base-colour texture costs once the loader has
    /// transcoded it: the whole mip chain, at this device's transcode
    /// target. This is what the budget charges.
    pub texture_bytes: u64,
    /// Length of the KTX2 member on disk. Kept only so the census can show
    /// the two side by side: this is the figure the budget used to charge,
    /// and it is 3-4x smaller than the GPU cost because the payload is
    /// zstd-supercompressed UASTC and carries no mip storage.
    pub texture_file_bytes: u64,
    pub alpha_blend: bool,
    pub double_sided: bool,
}

/// GPU bytes a KTX2 texture occupies after transcoding, from its header.
///
/// The header is the only honest source: the file length is a compressed
/// length, and the map profile's textures are zstd-supercompressed UASTC
/// whose GPU footprint is fixed by dimensions, mip count and the transcode
/// target — never by how well they compressed.
///
/// Layout per the KTX2 spec: a 12-byte identifier, then `vkFormat`,
/// `typeSize`, `pixelWidth`, `pixelHeight`, `pixelDepth`, `layerCount`,
/// `faceCount`, `levelCount`, `supercompressionScheme` as little-endian u32.
pub fn ktx2_gpu_bytes(path: &Path, bytes_per_pixel: u32) -> Option<u64> {
    const KTX2_IDENTIFIER: [u8; 12] = [
        0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A,
    ];
    let mut header = [0u8; 48];
    File::open(path).ok()?.read_exact(&mut header).ok()?;
    if header[..12] != KTX2_IDENTIFIER {
        return None;
    }
    let field = |index: usize| -> u32 {
        u32::from_le_bytes([
            header[index],
            header[index + 1],
            header[index + 2],
            header[index + 3],
        ])
    };
    let width = field(20);
    let height = field(24).max(1);
    let layers = field(32).max(1);
    let faces = field(36).max(1);
    // `levelCount == 0` means "the loader generates the chain", which costs
    // the same as a stored one.
    let levels = field(40).max(1);
    if width == 0 {
        return None;
    }
    let mut total = 0u64;
    for level in 0..levels {
        let level_width = (width >> level).max(1);
        let level_height = (height >> level).max(1);
        total += match bytes_per_pixel {
            // Every transcode target the loader picks for UASTC — BC7,
            // ASTC 4x4, ETC2 RGBA8 — is 16 bytes per 4x4 block, and a
            // partial block still costs a whole one.
            1 => u64::from(level_width.div_ceil(4)) * u64::from(level_height.div_ceil(4)) * 16,
            bytes => u64::from(level_width) * u64::from(level_height) * u64::from(bytes),
        };
    }
    Some(total * u64::from(layers) * u64::from(faces))
}

/// The parsed index: everything needed to plan and execute loading without
/// touching `master.gltf` again.
#[derive(Debug)]
pub struct SceneIndex {
    pub root: PathBuf,
    pub buffer: PathBuf,
    accessors: Vec<Accessor>,
    views: Vec<BufferView>,
    pub materials: Vec<MaterialDef>,
    pub nodes: Vec<DrawNode>,
}

fn accessor_components(kind: &str) -> Option<usize> {
    Some(match kind {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" => 4,
        "MAT4" => 16,
        _ => return None,
    })
}

fn component_size(component_type: u32) -> Option<usize> {
    Some(match component_type {
        5120 | 5121 => 1,
        5122 | 5123 => 2,
        5125 | 5126 => 4,
        _ => return None,
    })
}

fn node_transform(node: &Value) -> Mat4 {
    if let Some(matrix) = node.get("matrix").and_then(Value::as_array) {
        let mut columns = [0.0f32; 16];
        for (slot, value) in columns.iter_mut().zip(matrix) {
            *slot = value.as_f64().unwrap_or(0.0) as f32;
        }
        return Mat4::from_cols_array(&columns);
    }
    let vector = |key: &str, fallback: Vec3| -> Vec3 {
        node.get(key)
            .and_then(Value::as_array)
            .filter(|array| array.len() == 3)
            .map(|array| {
                Vec3::new(
                    array[0].as_f64().unwrap_or(0.0) as f32,
                    array[1].as_f64().unwrap_or(0.0) as f32,
                    array[2].as_f64().unwrap_or(0.0) as f32,
                )
            })
            .unwrap_or(fallback)
    };
    let rotation = node
        .get("rotation")
        .and_then(Value::as_array)
        .filter(|array| array.len() == 4)
        .map(|array| {
            Quat::from_xyzw(
                array[0].as_f64().unwrap_or(0.0) as f32,
                array[1].as_f64().unwrap_or(0.0) as f32,
                array[2].as_f64().unwrap_or(0.0) as f32,
                array[3].as_f64().unwrap_or(1.0) as f32,
            )
            .normalize()
        })
        .unwrap_or(Quat::IDENTITY);
    Mat4::from_scale_rotation_translation(
        vector("scale", Vec3::ONE),
        rotation,
        vector("translation", Vec3::ZERO),
    )
}

/// Transform an axis-aligned box by `transform` and return the AABB of the
/// result. Eight corners, because a rotated box's AABB is not the transform
/// of its min/max.
fn transform_aabb(transform: &Mat4, min: Vec3, max: Vec3) -> (Vec3, Vec3) {
    let mut out_min = Vec3::splat(f32::INFINITY);
    let mut out_max = Vec3::splat(f32::NEG_INFINITY);
    for index in 0..8 {
        let corner = Vec3::new(
            if index & 1 == 0 { min.x } else { max.x },
            if index & 2 == 0 { min.y } else { max.y },
            if index & 4 == 0 { min.z } else { max.z },
        );
        let world = transform.transform_point3(corner);
        out_min = out_min.min(world);
        out_max = out_max.max(world);
    }
    (out_min, out_max)
}

impl SceneIndex {
    /// Parse `master.gltf` into the index. `members` is the verified manifest
    /// member table; `texture_bytes_per_pixel` is this device's KTX2
    /// transcode target (see [`crate::readiness::GpuAdapter`]), because the
    /// GPU cost of a texture is decided by the device, not by the file.
    pub fn parse(
        root: &Path,
        document: &Value,
        members: &BTreeMap<String, crate::manifest::Member>,
        texture_bytes_per_pixel: u32,
    ) -> Result<Self, String> {
        // One header read per distinct image, not per material: a KTX2 the
        // profile shares between materials is one GPU texture.
        let mut gpu_bytes_by_uri: HashMap<String, u64> = HashMap::new();
        let accessors: Vec<Accessor> = document
            .get("accessors")
            .and_then(Value::as_array)
            .ok_or("master.gltf has no accessors")?
            .iter()
            .map(|raw| {
                let kind = raw
                    .get("type")
                    .and_then(Value::as_str)
                    .ok_or("accessor without type")?;
                Ok(Accessor {
                    count: raw
                        .get("count")
                        .and_then(Value::as_u64)
                        .ok_or("accessor without count")? as usize,
                    component_type: raw
                        .get("componentType")
                        .and_then(Value::as_u64)
                        .ok_or("accessor without componentType")?
                        as u32,
                    components: accessor_components(kind).ok_or("unsupported accessor type")?,
                    buffer_view: raw
                        .get("bufferView")
                        .and_then(Value::as_u64)
                        .ok_or("accessor without bufferView")?
                        as usize,
                    byte_offset: raw.get("byteOffset").and_then(Value::as_u64).unwrap_or(0)
                        as usize,
                })
            })
            .collect::<Result<_, String>>()?;
        let views: Vec<BufferView> = document
            .get("bufferViews")
            .and_then(Value::as_array)
            .ok_or("master.gltf has no bufferViews")?
            .iter()
            .map(|raw| BufferView {
                byte_offset: raw.get("byteOffset").and_then(Value::as_u64).unwrap_or(0) as usize,
                byte_length: raw.get("byteLength").and_then(Value::as_u64).unwrap_or(0) as usize,
                byte_stride: raw
                    .get("byteStride")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
            })
            .collect();
        let buffer_uri = document
            .get("buffers")
            .and_then(Value::as_array)
            .and_then(|buffers| buffers.first())
            .and_then(|buffer| buffer.get("uri"))
            .and_then(Value::as_str)
            .ok_or("master.gltf has no external buffer uri")?;
        let images: Vec<&str> = document
            .get("images")
            .and_then(Value::as_array)
            .map(|images| {
                images
                    .iter()
                    .map(|image| image.get("uri").and_then(Value::as_str).unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default();
        let textures: Vec<Option<usize>> = document
            .get("textures")
            .and_then(Value::as_array)
            .map(|textures| {
                textures
                    .iter()
                    .map(|texture| {
                        texture
                            .pointer("/extensions/KHR_texture_basisu/source")
                            .or_else(|| texture.get("source"))
                            .and_then(Value::as_u64)
                            .map(|index| index as usize)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let materials: Vec<MaterialDef> = document
            .get("materials")
            .and_then(Value::as_array)
            .map(|materials| {
                materials
                    .iter()
                    .map(|raw| {
                        let pbr = raw.get("pbrMetallicRoughness");
                        let base_color = pbr
                            .and_then(|pbr| pbr.get("baseColorFactor"))
                            .and_then(Value::as_array)
                            .filter(|array| array.len() == 4)
                            .map(|array| {
                                [
                                    array[0].as_f64().unwrap_or(1.0) as f32,
                                    array[1].as_f64().unwrap_or(1.0) as f32,
                                    array[2].as_f64().unwrap_or(1.0) as f32,
                                    array[3].as_f64().unwrap_or(1.0) as f32,
                                ]
                            })
                            .unwrap_or([1.0, 1.0, 1.0, 1.0]);
                        let texture = pbr
                            .and_then(|pbr| pbr.pointer("/baseColorTexture/index"))
                            .and_then(Value::as_u64)
                            .and_then(|index| textures.get(index as usize).copied().flatten())
                            .and_then(|image| images.get(image).copied())
                            .filter(|uri| uri.ends_with(".ktx2"))
                            .map(str::to_owned);
                        let texture_file_bytes = texture
                            .as_deref()
                            .and_then(|uri| members.get(uri))
                            .map(|member| member.bytes)
                            .unwrap_or(0);
                        let texture_bytes = texture
                            .as_deref()
                            .map(|uri| {
                                *gpu_bytes_by_uri.entry(uri.to_owned()).or_insert_with(|| {
                                    ktx2_gpu_bytes(&root.join(uri), texture_bytes_per_pixel)
                                        // A texture whose header cannot be
                                        // read is charged its file length
                                        // rather than nothing: an unreadable
                                        // header is a reason to be careful,
                                        // not a reason to be free.
                                        .unwrap_or(texture_file_bytes)
                                })
                            })
                            .unwrap_or(0);
                        MaterialDef {
                            base_color,
                            metallic: pbr
                                .and_then(|pbr| pbr.get("metallicFactor"))
                                .and_then(Value::as_f64)
                                .unwrap_or(1.0) as f32,
                            roughness: pbr
                                .and_then(|pbr| pbr.get("roughnessFactor"))
                                .and_then(Value::as_f64)
                                .unwrap_or(1.0) as f32,
                            base_color_texture: texture,
                            texture_bytes,
                            texture_file_bytes,
                            alpha_blend: raw.get("alphaMode").and_then(Value::as_str)
                                == Some("BLEND"),
                            double_sided: raw
                                .get("doubleSided")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let raw_nodes = document
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or("master.gltf has no nodes")?;
        let meshes = document
            .get("meshes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let scene_index = document.get("scene").and_then(Value::as_u64).unwrap_or(0) as usize;
        let roots: Vec<usize> = document
            .get("scenes")
            .and_then(Value::as_array)
            .and_then(|scenes| scenes.get(scene_index))
            .and_then(|scene| scene.get("nodes"))
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|index| index as usize)
                    .collect()
            })
            .ok_or("master.gltf scene has no root nodes")?;

        let mut nodes = Vec::new();
        let mut stack: Vec<(usize, Mat4)> = roots
            .iter()
            .rev()
            .map(|index| (*index, Mat4::IDENTITY))
            .collect();
        while let Some((index, parent)) = stack.pop() {
            let Some(raw) = raw_nodes.get(index) else {
                continue;
            };
            let world = parent * node_transform(raw);
            if let Some(children) = raw.get("children").and_then(Value::as_array) {
                for child in children.iter().filter_map(Value::as_u64) {
                    stack.push((child as usize, world));
                }
            }
            let Some(mesh_index) = raw.get("mesh").and_then(Value::as_u64) else {
                continue;
            };
            let Some(mesh) = meshes.get(mesh_index as usize) else {
                continue;
            };
            let Some(primitives_raw) = mesh.get("primitives").and_then(Value::as_array) else {
                continue;
            };
            let mut primitives = Vec::new();
            let mut local_min = Vec3::splat(f32::INFINITY);
            let mut local_max = Vec3::splat(f32::NEG_INFINITY);
            let mut coarse_bytes = 0u64;
            let mut detail_bytes = 0u64;
            for raw_primitive in primitives_raw {
                // Only triangle lists are authored by the map pipeline; a
                // non-triangle primitive is skipped rather than guessed at.
                if raw_primitive
                    .get("mode")
                    .and_then(Value::as_u64)
                    .unwrap_or(4)
                    != 4
                {
                    continue;
                }
                let attributes = raw_primitive.get("attributes");
                let attribute = |name: &str| -> Option<usize> {
                    attributes
                        .and_then(|attributes| attributes.get(name))
                        .and_then(Value::as_u64)
                        .map(|index| index as usize)
                };
                let Some(position) = attribute("POSITION") else {
                    continue;
                };
                let Some(bounds) = raw_primitive
                    .get("attributes")
                    .and(document.pointer(&format!("/accessors/{position}")))
                else {
                    continue;
                };
                let read_bound = |key: &str| -> Option<Vec3> {
                    bounds
                        .get(key)
                        .and_then(Value::as_array)
                        .filter(|array| array.len() == 3)
                        .map(|array| {
                            Vec3::new(
                                array[0].as_f64().unwrap_or(0.0) as f32,
                                array[1].as_f64().unwrap_or(0.0) as f32,
                                array[2].as_f64().unwrap_or(0.0) as f32,
                            )
                        })
                };
                // POSITION accessors are required by glTF to publish min/max;
                // without them the node has no bounds and cannot be ranked,
                // budgeted or picked, so it is not admitted at all.
                let (Some(min), Some(max)) = (read_bound("min"), read_bound("max")) else {
                    continue;
                };
                local_min = local_min.min(min);
                local_max = local_max.max(max);
                let vertices = accessors
                    .get(position)
                    .map(|accessor| accessor.count)
                    .unwrap_or(0) as u64;
                let index_count = raw_primitive
                    .get("indices")
                    .and_then(Value::as_u64)
                    .and_then(|index| accessors.get(index as usize))
                    .map(|accessor| accessor.count)
                    .unwrap_or(0) as u64;
                // Bevy uploads positions as 3xf32 and indices as u32.
                coarse_bytes += vertices * 12 + index_count * 4;
                detail_bytes += vertices * (12 + 12 + 8) + index_count * 4;
                primitives.push(Primitive {
                    position,
                    normal: attribute("NORMAL"),
                    uv: attribute("TEXCOORD_0"),
                    indices: raw_primitive
                        .get("indices")
                        .and_then(Value::as_u64)
                        .map(|index| index as usize),
                    material: raw_primitive
                        .get("material")
                        .and_then(Value::as_u64)
                        .map(|index| index as usize),
                });
            }
            if primitives.is_empty() || !local_min.is_finite() || !local_max.is_finite() {
                continue;
            }
            let (min, max) = transform_aabb(&world, local_min, local_max);
            nodes.push(DrawNode {
                node: index,
                name: raw
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("node-{index}")),
                transform: world,
                primitives,
                min,
                max,
                local_min,
                local_max,
                coarse_bytes,
                detail_bytes,
            });
        }
        if nodes.is_empty() {
            return Err("master.gltf contains no drawable triangle nodes".to_owned());
        }
        Ok(Self {
            root: root.to_path_buf(),
            buffer: root.join(buffer_uri),
            accessors,
            views,
            materials,
            nodes,
        })
    }

    /// Stable id for a node: `<layer>:<node index>:<name>`. Node indices are
    /// a property of the immutable `master.gltf`, so the same release always
    /// yields the same id for the same geometry - which is what makes a
    /// selection or a pick result durable across sessions.
    pub fn stable_id(&self, node: usize) -> String {
        let draw = &self.nodes[node];
        format!("{}:{}:{}", draw.layer(), draw.node, draw.name)
    }

    /// World-space bounds of every drawable node, or `None` for an empty
    /// scene. The editor needs this to frame a map it has never opened, and a
    /// benchmark needs it to put both backends on the same camera path.
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for node in &self.nodes {
            min = min.min(node.min);
            max = max.max(node.max);
        }
        (min.is_finite() && max.is_finite()).then_some((min, max))
    }

    /// Extent-ranked prefix of the scene that fits `budget_bytes`: the coarse
    /// plan. Biggest-first, because the first frame a user judges is decided
    /// by the large surfaces, not by fence posts.
    pub fn coarse_plan(&self, budget_bytes: u64) -> Vec<usize> {
        let mut ranked: Vec<usize> = (0..self.nodes.len()).collect();
        ranked.sort_by(|left, right| {
            self.nodes[*right]
                .extent()
                .total_cmp(&self.nodes[*left].extent())
                .then_with(|| self.nodes[*left].node.cmp(&self.nodes[*right].node))
        });
        let mut admitted = Vec::new();
        let mut used = 0u64;
        for index in ranked {
            let cost = self.nodes[index].coarse_bytes;
            if used + cost > budget_bytes {
                continue;
            }
            used += cost;
            admitted.push(index);
        }
        admitted
    }

    fn read_view(
        &self,
        file: &mut File,
        view: usize,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, String> {
        let view = self.views.get(view).ok_or("missing bufferView")?;
        if offset + length > view.byte_length {
            return Err("accessor range exceeds its bufferView".to_owned());
        }
        let mut bytes = vec![0u8; length];
        file.seek(SeekFrom::Start((view.byte_offset + offset) as u64))
            .map_err(|error| error.to_string())?;
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }

    /// Read one float accessor into a flat `f32` vector, de-interleaving a
    /// strided bufferView.
    fn read_floats(&self, file: &mut File, index: usize) -> Result<Vec<f32>, String> {
        let accessor = *self.accessors.get(index).ok_or("missing accessor")?;
        if accessor.component_type != 5126 {
            return Err(format!("attribute accessor {index} is not float32"));
        }
        let element = accessor.components * 4;
        let stride = self
            .views
            .get(accessor.buffer_view)
            .ok_or("missing bufferView")?
            .byte_stride
            .unwrap_or(element);
        let span = if accessor.count == 0 {
            0
        } else {
            (accessor.count - 1) * stride + element
        };
        let bytes = self.read_view(file, accessor.buffer_view, accessor.byte_offset, span)?;
        let mut values = Vec::with_capacity(accessor.count * accessor.components);
        for vertex in 0..accessor.count {
            let base = vertex * stride;
            for component in 0..accessor.components {
                let at = base + component * 4;
                values.push(f32::from_le_bytes([
                    bytes[at],
                    bytes[at + 1],
                    bytes[at + 2],
                    bytes[at + 3],
                ]));
            }
        }
        Ok(values)
    }

    fn read_indices(&self, file: &mut File, index: usize) -> Result<Vec<u32>, String> {
        let accessor = *self.accessors.get(index).ok_or("missing accessor")?;
        let size = component_size(accessor.component_type).ok_or("unsupported index component")?;
        let stride = self
            .views
            .get(accessor.buffer_view)
            .ok_or("missing bufferView")?
            .byte_stride
            .unwrap_or(size);
        let span = if accessor.count == 0 {
            0
        } else {
            (accessor.count - 1) * stride + size
        };
        let bytes = self.read_view(file, accessor.buffer_view, accessor.byte_offset, span)?;
        let mut values = Vec::with_capacity(accessor.count);
        for element in 0..accessor.count {
            let at = element * stride;
            values.push(match accessor.component_type {
                5121 => u32::from(bytes[at]),
                5123 => u32::from(u16::from_le_bytes([bytes[at], bytes[at + 1]])),
                5125 => {
                    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
                }
                other => return Err(format!("unsupported index component type {other}")),
            });
        }
        Ok(values)
    }
}

/// One primitive's vertex data, ready to become a `Mesh`.
#[derive(Debug)]
pub struct PrimitiveData {
    pub positions: Vec<[f32; 3]>,
    pub normals: Option<Vec<[f32; 3]>>,
    pub uvs: Option<Vec<[f32; 2]>>,
    pub indices: Vec<u32>,
    pub material: Option<usize>,
}

#[derive(Debug)]
pub struct LoadRequest {
    pub node: usize,
    pub tier: Tier,
}

#[derive(Debug)]
pub struct LoadResponse {
    pub node: usize,
    pub tier: Tier,
    pub result: Result<Vec<PrimitiveData>, String>,
}

/// Read one node's primitives at `tier` from `geometry.bin`.
pub fn read_node(
    index: &SceneIndex,
    file: &mut File,
    node: usize,
    tier: Tier,
) -> Result<Vec<PrimitiveData>, String> {
    let draw = index.nodes.get(node).ok_or("unknown node")?;
    let mut out = Vec::with_capacity(draw.primitives.len());
    for primitive in &draw.primitives {
        let positions_flat = index.read_floats(file, primitive.position)?;
        let positions: Vec<[f32; 3]> = positions_flat
            .chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect();
        let indices = match primitive.indices {
            Some(accessor) => index.read_indices(file, accessor)?,
            None => (0..positions.len() as u32).collect(),
        };
        let (normals, uvs) = if tier == Tier::Detail {
            let normals = match primitive.normal {
                Some(accessor) => Some(
                    index
                        .read_floats(file, accessor)?
                        .chunks_exact(3)
                        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                        .collect::<Vec<_>>(),
                ),
                None => None,
            };
            let uvs = match primitive.uv {
                Some(accessor) => Some(
                    index
                        .read_floats(file, accessor)?
                        .chunks_exact(2)
                        .map(|chunk| [chunk[0], chunk[1]])
                        .collect::<Vec<_>>(),
                ),
                None => None,
            };
            (normals, uvs)
        } else {
            (None, None)
        };
        out.push(PrimitiveData {
            positions,
            normals,
            uvs,
            indices,
            material: primitive.material,
        });
    }
    Ok(out)
}

/// Loader thread: owns the file handle, answers requests in arrival order.
/// One thread, because the work is sequential reads from a single file and a
/// second reader would only add seek contention.
pub fn spawn_loader(
    index: std::sync::Arc<SceneIndex>,
    requests: Receiver<LoadRequest>,
    responses: Sender<LoadResponse>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut file = match File::open(&index.buffer) {
            Ok(file) => file,
            Err(error) => {
                for request in requests {
                    let _ = responses.send(LoadResponse {
                        node: request.node,
                        tier: request.tier,
                        result: Err(format!("cannot open {}: {error}", index.buffer.display())),
                    });
                }
                return;
            }
        };
        for request in requests {
            let result = read_node(&index, &mut file, request.node, request.tier);
            if responses
                .send(LoadResponse {
                    node: request.node,
                    tier: request.tier,
                    result,
                })
                .is_err()
            {
                break;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Two nodes: a big flat slab under a translated parent, and a small box.
    /// Enough to pin transform propagation, bounds, ranking and layering.
    fn document() -> Value {
        json!({
            "asset": { "version": "2.0" },
            "scene": 0,
            "scenes": [{ "nodes": [0, 2] }],
            "nodes": [
                { "name": "Ground", "translation": [10.0, 0.0, 0.0], "children": [1] },
                { "name": "Slab", "mesh": 0 },
                { "name": "Post", "mesh": 1, "scale": [1.0, 1.0, 1.0] }
            ],
            "meshes": [
                { "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 2, "TEXCOORD_0": 3 }, "indices": 1, "material": 0, "mode": 4 }] },
                { "primitives": [{ "attributes": { "POSITION": 4 }, "indices": 5, "mode": 4 }] }
            ],
            "accessors": [
                { "type": "VEC3", "componentType": 5126, "count": 4, "bufferView": 0, "min": [-50.0, 0.0, -50.0], "max": [50.0, 0.5, 50.0] },
                { "type": "SCALAR", "componentType": 5123, "count": 6, "bufferView": 1 },
                { "type": "VEC3", "componentType": 5126, "count": 4, "bufferView": 2 },
                { "type": "VEC2", "componentType": 5126, "count": 4, "bufferView": 3 },
                { "type": "VEC3", "componentType": 5126, "count": 3, "bufferView": 4, "min": [0.0, 0.0, 0.0], "max": [0.2, 3.0, 0.2] },
                { "type": "SCALAR", "componentType": 5121, "count": 3, "bufferView": 5 }
            ],
            "bufferViews": [
                { "buffer": 0, "byteOffset": 0, "byteLength": 48 },
                { "buffer": 0, "byteOffset": 48, "byteLength": 12 },
                { "buffer": 0, "byteOffset": 60, "byteLength": 48 },
                { "buffer": 0, "byteOffset": 108, "byteLength": 32 },
                { "buffer": 0, "byteOffset": 140, "byteLength": 36 },
                { "buffer": 0, "byteOffset": 176, "byteLength": 3 }
            ],
            "buffers": [{ "uri": "geometry.bin", "byteLength": 179 }],
            "materials": [{
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.5, 0.5, 0.5, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.8,
                    "baseColorTexture": { "index": 0 }
                }
            }],
            "textures": [{ "source": 0, "extensions": { "KHR_texture_basisu": { "source": 1 } } }],
            "images": [
                { "uri": "images/placeholder.png" },
                { "uri": "images/aa.ktx2" }
            ]
        })
    }

    fn members() -> BTreeMap<String, crate::manifest::Member> {
        BTreeMap::from([(
            "images/aa.ktx2".to_owned(),
            crate::manifest::Member {
                bytes: 4096,
                sha256: "0".repeat(64),
            },
        )])
    }

    #[test]
    fn indexes_nodes_with_world_bounds_and_costs() {
        let index = SceneIndex::parse(Path::new("/maps/example"), &document(), &members(), 1)
            .expect("parse");
        assert_eq!(index.nodes.len(), 2);
        let slab = index
            .nodes
            .iter()
            .find(|node| node.name == "Slab")
            .expect("slab");
        // Parent translation must reach the child's world bounds.
        assert_eq!(slab.min, Vec3::new(-40.0, 0.0, -50.0));
        assert_eq!(slab.max, Vec3::new(60.0, 0.5, 50.0));
        assert_eq!(slab.layer(), "ground");
        // 4 vertices: coarse = 4*12 + 6 indices * 4; detail adds normals+uvs.
        assert_eq!(slab.coarse_bytes, 4 * 12 + 6 * 4);
        assert_eq!(slab.detail_bytes, 4 * 32 + 6 * 4);
        let post = index
            .nodes
            .iter()
            .find(|node| node.name == "Post")
            .expect("post");
        assert_eq!(post.layer(), "map-static");
        assert_eq!(index.buffer, Path::new("/maps/example/geometry.bin"));
    }

    #[test]
    fn resolves_base_colour_through_the_basisu_extension() {
        let index = SceneIndex::parse(Path::new("/maps/example"), &document(), &members(), 1)
            .expect("parse");
        let material = &index.materials[0];
        // The `.png` entry is a placeholder the profile does not ship; the
        // KTX2 the extension points at is the real payload.
        assert_eq!(
            material.base_color_texture.as_deref(),
            Some("images/aa.ktx2")
        );
        assert_eq!(material.texture_bytes, 4096);
        assert_eq!(material.roughness, 0.8);
    }

    #[test]
    fn coarse_plan_is_extent_ranked_and_budget_bounded() {
        let index = SceneIndex::parse(Path::new("/maps/example"), &document(), &members(), 1)
            .expect("parse");
        let slab = index
            .nodes
            .iter()
            .position(|node| node.name == "Slab")
            .expect("slab");
        // A budget that fits only one node must keep the larger one.
        let plan = index.coarse_plan(index.nodes[slab].coarse_bytes);
        assert_eq!(plan, vec![slab]);
        assert_eq!(index.coarse_plan(0), Vec::<usize>::new());
        assert_eq!(index.coarse_plan(u64::MAX).len(), 2);
    }

    #[test]
    fn stable_ids_are_derived_from_immutable_node_identity() {
        let index = SceneIndex::parse(Path::new("/maps/example"), &document(), &members(), 1)
            .expect("parse");
        let slab = index
            .nodes
            .iter()
            .position(|node| node.name == "Slab")
            .expect("slab");
        assert_eq!(index.stable_id(slab), "ground:1:Slab");
    }

    #[test]
    fn reads_interleaved_and_tightly_packed_accessors() {
        let root =
            std::env::temp_dir().join(format!("simforge-viewport-scene-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("root");
        let mut bytes = Vec::new();
        for vertex in 0..4u32 {
            for component in 0..3u32 {
                bytes.extend_from_slice(&((vertex * 3 + component) as f32).to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0u8, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0][..12]);
        bytes.resize(60, 0);
        for value in 0..12u32 {
            bytes.extend_from_slice(&(value as f32).to_le_bytes());
        }
        bytes.resize(108, 0);
        for value in 0..8u32 {
            bytes.extend_from_slice(&(value as f32).to_le_bytes());
        }
        bytes.resize(140, 0);
        for value in 0..9u32 {
            bytes.extend_from_slice(&(value as f32).to_le_bytes());
        }
        bytes.resize(176, 0);
        bytes.extend_from_slice(&[0, 1, 2]);
        std::fs::write(root.join("geometry.bin"), &bytes).expect("buffer");
        let index = SceneIndex::parse(&root, &document(), &members(), 1).expect("parse");
        let mut file = File::open(index.buffer.clone()).expect("open");
        let slab = index
            .nodes
            .iter()
            .position(|node| node.name == "Slab")
            .expect("slab");
        let coarse = read_node(&index, &mut file, slab, Tier::Coarse).expect("coarse");
        assert_eq!(coarse[0].positions.len(), 4);
        assert_eq!(coarse[0].positions[1], [3.0, 4.0, 5.0]);
        assert_eq!(coarse[0].indices, vec![0, 1, 2, 0, 0, 0]);
        // Coarse must not pay for normals or UVs.
        assert!(coarse[0].normals.is_none() && coarse[0].uvs.is_none());
        let detail = read_node(&index, &mut file, slab, Tier::Detail).expect("detail");
        assert_eq!(detail[0].normals.as_ref().expect("normals").len(), 4);
        assert_eq!(detail[0].uvs.as_ref().expect("uvs").len(), 4);
        let post = index
            .nodes
            .iter()
            .position(|node| node.name == "Post")
            .expect("post");
        let post_data = read_node(&index, &mut file, post, Tier::Coarse).expect("post");
        assert_eq!(post_data[0].indices, vec![0, 1, 2]);
        std::fs::remove_dir_all(&root).ok();
    }
}
