//! Deterministic CPU raycast scene: triangle soup + flat median-split BVH.
//!
//! Used by the lidar and radar models. Determinism notes:
//! - triangles are sorted by centroid lexicographic order before building, so
//!   identical input geometry yields an identical tree and identical hits;
//! - the BVH build uses `select_nth_unstable_by_key` on f32 bit patterns;
//! - ray-triangle intersection is Möller–Trumbore with a fixed epsilon.

use bevy::math::{Mat4, Vec3};

/// A world-space triangle with its owning instance id.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tri {
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    /// Instance id from the capture legend.
    pub instance_id: u32,
}

impl Tri {
    pub fn centroid(&self) -> Vec3 {
        (self.a + self.b + self.c) * (1.0 / 3.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Node {
    min: Vec3,
    max: Vec3,
    /// Leaf: first triangle index. Interior: left child node index.
    left_first: u32,
    /// Leaf: triangle count. Interior: 0.
    count: u32,
    /// Interior: right child node index.
    right: u32,
}

#[derive(Debug, Clone, Default)]
pub struct RaycastScene {
    tris: Vec<Tri>,
    nodes: Vec<Node>,
}

const EPS: f32 = 1e-9;

/// On-disk sensor BVH format tag; bump the last byte when the layout or the
/// build algorithm changes (a changed build must never load an old tree).
const BVH_FILE_MAGIC: &[u8; 8] = b"SFBVH\x00\x00\x01";
const TRI_BYTES: usize = 40;
const NODE_BYTES: usize = 36;

/// Levels of the triangle BVH whose two subtrees build on separate threads
/// (up to 2^PARALLEL_DEPTH concurrent builders).
pub const PARALLEL_DEPTH: u32 = 5;
/// Subtrees (and sort chunks) smaller than this stay on one thread.
const PARALLEL_MIN_TRIS: usize = 65_536;
/// Chunks sorted concurrently before the final run-merging sort.
const SORT_CHUNKS: usize = 32;

impl Node {
    const PLACEHOLDER: Node = Node {
        min: Vec3::ZERO,
        max: Vec3::ZERO,
        left_first: 0,
        count: 0,
        right: 0,
    };
}

/// Centroid lexicographic order (the historical comparator, NaN as equal).
fn centroid_cmp(a: &Tri, b: &Tri) -> std::cmp::Ordering {
    let (ca, cb) = (a.centroid(), b.centroid());
    ca.x.partial_cmp(&cb.x)
        .unwrap_or(std::cmp::Ordering::Equal) // fallback-ok: NaN-safe comparator in the historical sort order
        .then(ca.y.partial_cmp(&cb.y).unwrap_or(std::cmp::Ordering::Equal))
        .then(ca.z.partial_cmp(&cb.z).unwrap_or(std::cmp::Ordering::Equal)) // fallback-ok: NaN-safe comparator in the historical sort order
}

/// Stable sort by [`centroid_cmp`], identical to `tris.sort_by(centroid_cmp)`:
/// contiguous chunks are stably sorted in parallel, then one stable sort
/// merges the resulting runs. Equal elements keep their input order both
/// within a chunk and across chunks, which is exactly the stable result.
fn parallel_stable_sort(tris: &mut [Tri]) {
    if tris.len() < PARALLEL_MIN_TRIS * 2 {
        tris.sort_by(centroid_cmp);
        return;
    }
    let chunk = tris.len().div_ceil(SORT_CHUNKS);
    std::thread::scope(|scope| {
        for part in tris.chunks_mut(chunk) {
            scope.spawn(move || part.sort_by(centroid_cmp));
        }
    });
    tris.sort_by(centroid_cmp);
}

fn tri_bounds(tris: &[Tri]) -> (Vec3, Vec3) {
    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);
    for t in tris {
        for p in [t.a, t.b, t.c] {
            min = min.min(p);
            max = max.max(p);
        }
    }
    (min, max)
}

/// Median split on the widest axis of the bounds: partitions `tris` in
/// place and returns the left count.
fn median_split(tris: &mut [Tri], bmin: Vec3, bmax: Vec3) -> usize {
    let ext = bmax - bmin;
    let axis = if ext.x >= ext.y && ext.x >= ext.z {
        0
    } else if ext.y >= ext.z {
        1
    } else {
        2
    };
    let half = tris.len() / 2;
    tris.select_nth_unstable_by_key(half, |t| {
        let c = t.centroid();
        match axis {
            0 => c.x.to_bits(),
            1 => c.y.to_bits(),
            _ => c.z.to_bits(),
        }
    });
    half
}

/// Nodes in the median-split subtree over `count` triangles.
fn node_count(count: usize) -> usize {
    if count <= 4 {
        1
    } else {
        1 + node_count(count / 2) + node_count(count - count / 2)
    }
}

/// Write the preorder subtree over `tris` (first global triangle `first`)
/// into `nodes`, whose element 0 has absolute index `base`.
fn fill_nodes(nodes: &mut [Node], base: u32, tris: &mut [Tri], first: u32, depth: u32) {
    let count = tris.len();
    let (bmin, bmax) = tri_bounds(tris);
    if count <= 4 {
        nodes[0] = Node {
            min: bmin,
            max: bmax,
            left_first: first,
            count: count as u32,
            right: 0,
        };
        return;
    }
    let half = median_split(tris, bmin, bmax);
    let left_len = node_count(half);
    nodes[0] = Node {
        min: bmin,
        max: bmax,
        left_first: base + 1,
        count: 0,
        right: base + 1 + left_len as u32,
    };
    let (left_nodes, right_nodes) = nodes[1..].split_at_mut(left_len);
    let (left_tris, right_tris) = tris.split_at_mut(half);
    let right_base = base + 1 + left_len as u32;
    let right_first = first + half as u32;
    if depth < PARALLEL_DEPTH && count >= PARALLEL_MIN_TRIS {
        std::thread::scope(|scope| {
            scope.spawn(move || {
                fill_nodes(right_nodes, right_base, right_tris, right_first, depth + 1)
            });
            fill_nodes(left_nodes, base + 1, left_tris, first, depth + 1);
        });
    } else {
        fill_nodes(left_nodes, base + 1, left_tris, first, depth + 1);
        fill_nodes(right_nodes, right_base, right_tris, right_first, depth + 1);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Hit {
    pub distance: f32,
    pub point: Vec3,
    pub instance_id: u32,
    pub normal: Vec3,
}

/// Raycast surface accepted by deterministic sensor models. A persistent
/// service can compose a cached static BVH with a per-tick actor BVH.
pub trait Raycast: Sync {
    fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit>;
}

impl RaycastScene {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_tri(&mut self, tri: Tri) {
        self.tris.push(tri);
    }

    pub fn tri_count(&self) -> usize {
        self.tris.len()
    }

    /// Build the BVH. Call once after all triangles are pushed.
    ///
    /// Produces exactly the serial median-split tree (same triangle order,
    /// same preorder node layout; tested against the serial reference), with
    /// the work spread over threads: the stable centroid sort runs on chunks
    /// in parallel before one run-merging pass, and the top
    /// [`PARALLEL_DEPTH`] levels build their two subtrees concurrently into
    /// disjoint, precomputed slices of the node array.
    pub fn build(&mut self) {
        let n = self.tris.len();
        self.nodes.clear();
        if n == 0 {
            return;
        }
        parallel_stable_sort(&mut self.tris);
        let mut nodes = vec![Node::PLACEHOLDER; node_count(n)];
        fill_nodes(&mut nodes, 0, &mut self.tris, 0, 0);
        self.nodes = nodes;
    }

    /// Triangles in the scene (in build order once built).
    pub fn triangle_count(&self) -> usize {
        self.tris.len()
    }

    /// Serialise the built scene (triangles in build order + nodes) for the
    /// on-disk sensor-scene cache. [`Self::read_from`] restores exactly this
    /// tree, so raycasts against it are bit-identical to the fresh build.
    pub fn write_to(&self, out: &mut impl std::io::Write) -> std::io::Result<()> {
        out.write_all(BVH_FILE_MAGIC)?;
        out.write_all(&(self.tris.len() as u64).to_le_bytes())?;
        out.write_all(&(self.nodes.len() as u64).to_le_bytes())?;
        let mut buffer = Vec::with_capacity(1 << 20);
        let mut flush =
            |buffer: &mut Vec<u8>, out: &mut dyn std::io::Write| -> std::io::Result<()> {
                out.write_all(buffer)?;
                buffer.clear();
                Ok(())
            };
        for tri in &self.tris {
            for v in [tri.a, tri.b, tri.c] {
                for c in v.to_array() {
                    buffer.extend_from_slice(&c.to_bits().to_le_bytes());
                }
            }
            buffer.extend_from_slice(&tri.instance_id.to_le_bytes());
            if buffer.len() >= 1 << 20 {
                flush(&mut buffer, out)?;
            }
        }
        for node in &self.nodes {
            for v in [node.min, node.max] {
                for c in v.to_array() {
                    buffer.extend_from_slice(&c.to_bits().to_le_bytes());
                }
            }
            for word in [node.left_first, node.count, node.right] {
                buffer.extend_from_slice(&word.to_le_bytes());
            }
            if buffer.len() >= 1 << 20 {
                flush(&mut buffer, out)?;
            }
        }
        flush(&mut buffer, out)
    }

    /// Restore a scene written by [`Self::write_to`].
    pub fn read_from(input: &mut impl std::io::Read) -> std::io::Result<Self> {
        use std::io::{Error, ErrorKind};
        let mut magic = [0u8; 8];
        input.read_exact(&mut magic)?;
        if &magic != BVH_FILE_MAGIC {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "not a sensor BVH file (or another format version)",
            ));
        }
        let mut word = [0u8; 8];
        input.read_exact(&mut word)?;
        let tri_count = u64::from_le_bytes(word) as usize;
        input.read_exact(&mut word)?;
        let node_count = u64::from_le_bytes(word) as usize;
        if node_count > 2 * tri_count.max(1) {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "sensor BVH node count exceeds its triangle bound",
            ));
        }
        let mut bytes = vec![0u8; tri_count * TRI_BYTES];
        input.read_exact(&mut bytes)?;
        let f = |chunk: &[u8], index: usize| {
            f32::from_bits(u32::from_le_bytes(
                chunk[index * 4..index * 4 + 4].try_into().unwrap(),
            ))
        };
        let u = |chunk: &[u8], index: usize| {
            u32::from_le_bytes(chunk[index * 4..index * 4 + 4].try_into().unwrap())
        };
        let tris = bytes
            .chunks_exact(TRI_BYTES)
            .map(|c| Tri {
                a: Vec3::new(f(c, 0), f(c, 1), f(c, 2)),
                b: Vec3::new(f(c, 3), f(c, 4), f(c, 5)),
                c: Vec3::new(f(c, 6), f(c, 7), f(c, 8)),
                instance_id: u(c, 9),
            })
            .collect();
        let mut bytes = vec![0u8; node_count * NODE_BYTES];
        input.read_exact(&mut bytes)?;
        let nodes = bytes
            .chunks_exact(NODE_BYTES)
            .map(|c| Node {
                min: Vec3::new(f(c, 0), f(c, 1), f(c, 2)),
                max: Vec3::new(f(c, 3), f(c, 4), f(c, 5)),
                left_first: u(c, 6),
                count: u(c, 7),
                right: u(c, 8),
            })
            .collect();
        let mut trailing = [0u8; 1];
        if input.read(&mut trailing)? != 0 {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "sensor BVH file has trailing bytes",
            ));
        }
        Ok(Self { tris, nodes })
    }

    /// The original single-threaded build, kept as the reference the
    /// parallel build must reproduce bit for bit.
    #[cfg(test)]
    fn build_serial(&mut self) {
        let n = self.tris.len();
        self.nodes.clear();
        if n == 0 {
            return;
        }
        self.tris.sort_by(centroid_cmp);
        self.nodes.reserve(2 * n);
        self.subdivide(0, n as u32);
    }

    #[cfg(test)]
    fn subdivide(&mut self, first: u32, count: u32) -> u32 {
        let node_index = self.nodes.len() as u32;
        let range = first as usize..(first + count) as usize;
        let (bmin, bmax) = tri_bounds(&self.tris[range.clone()]);
        if count <= 4 {
            self.nodes.push(Node {
                min: bmin,
                max: bmax,
                left_first: first,
                count,
                right: 0,
            });
            return node_index;
        }
        let half = median_split(&mut self.tris[range], bmin, bmax) as u32;
        let mid = first + half;
        self.nodes.push(Node {
            min: bmin,
            max: bmax,
            left_first: 0,
            count: 0,
            right: 0,
        });
        let left = self.subdivide(first, mid - first);
        let right = self.subdivide(mid, first + count - mid);
        self.nodes[node_index as usize].left_first = left;
        self.nodes[node_index as usize].right = right;
        node_index
    }

    /// Nearest hit within `t_max` along `dir` (need not be normalized; the
    /// returned distance is in units of |dir|).
    pub fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit> {
        if self.nodes.is_empty() {
            return None;
        }
        let inv_dir = dir.recip();
        let mut best: Option<Hit> = None;
        let mut best_t = t_max;
        let mut stack = [0u32; 128];
        let mut sp = 0usize;
        stack[sp] = 0;
        sp += 1;
        while sp > 0 {
            sp -= 1;
            let node = &self.nodes[stack[sp] as usize];
            if !ray_aabb(origin, inv_dir, best_t, node.min, node.max) {
                continue;
            }
            if node.count > 0 {
                for ti in node.left_first..node.left_first + node.count {
                    if let Some(hit) = ray_tri(origin, dir, &self.tris[ti as usize]) {
                        if hit.distance < best_t {
                            best_t = hit.distance;
                            best = Some(hit);
                        }
                    }
                }
            } else {
                stack[sp] = node.right;
                sp += 1;
                stack[sp] = node.left_first;
                sp += 1;
            }
        }
        best
    }
}

impl Raycast for RaycastScene {
    fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit> {
        RaycastScene::cast(self, origin, dir, t_max)
    }
}

fn ray_aabb(origin: Vec3, inv_dir: Vec3, t_max: f32, min: Vec3, max: Vec3) -> bool {
    let mut tmin = f32::NEG_INFINITY;
    let mut tmax = f32::INFINITY;
    for k in 0..3 {
        let o = origin[k];
        let d = inv_dir[k];
        let lo = min[k];
        let hi = max[k];
        if d.abs() < EPS {
            if o < lo || o > hi {
                return false;
            }
        } else {
            let mut t0 = (lo - o) * d;
            let mut t1 = (hi - o) * d;
            if t0 > t1 {
                std::mem::swap(&mut t0, &mut t1);
            }
            tmin = tmin.max(t0);
            tmax = tmax.min(t1);
            if tmin > tmax {
                return false;
            }
        }
    }
    tmax >= 0.0 && tmin <= t_max
}

/// Minimum |cos(incidence)| of an accepted hit (incidence measured from the
/// triangle normal): rays within ~2.9 degrees of grazing are misses.
///
/// Near grazing, f32 Möller–Trumbore in world coordinates cancels
/// catastrophically: the barycentrics of a ray that misses the triangle by
/// metres can land inside [0, 1] and produce a ghost return (the parity
/// test for the hardware backend found them at ~0.1% of adversarial rays).
/// Bounding the incidence bounds the positional error of every accepted
/// hit by about `eps * |coord| / cos`, a few millimetres at map scale,
/// which is what lets both the CPU trees ([`Blas`] slack) and the hardware
/// backend (triangle inflation) be provably conservative. Real returns at
/// such incidence are negligible (the modelled intensity is already at its
/// floor) and a physical lidar does not report them either.
pub const MIN_INCIDENCE_COS: f32 = 0.05;
const MIN_INCIDENCE_COS2: f32 = MIN_INCIDENCE_COS * MIN_INCIDENCE_COS;

/// Möller–Trumbore. Distance is along the unnormalized `dir`.
///
/// The operation order is part of the contract: `crate::gpu_rays` re-runs
/// exactly these IEEE f32 operations on the GPU to stay bit-identical.
fn ray_tri_distance(origin: Vec3, dir: Vec3, tri: &Tri) -> Option<f32> {
    let e1 = tri.b - tri.a;
    let e2 = tri.c - tri.a;
    let pvec = dir.cross(e2);
    let det = e1.dot(pvec);
    if det.abs() < EPS {
        return None;
    }
    // |det| = |e1 x e2| |dir| |cos|: compare squares, no square roots.
    let normal = e1.cross(e2);
    if det * det < MIN_INCIDENCE_COS2 * (normal.dot(normal) * dir.dot(dir)) {
        return None;
    }
    let inv_det = 1.0 / det;
    let tvec = origin - tri.a;
    let u = tvec.dot(pvec) * inv_det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let qvec = tvec.cross(e1);
    let v = dir.dot(qvec) * inv_det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = e2.dot(qvec) * inv_det;
    if t <= EPS {
        return None;
    }
    Some(t)
}

fn ray_tri(origin: Vec3, dir: Vec3, tri: &Tri) -> Option<Hit> {
    let distance = ray_tri_distance(origin, dir, tri)?;
    Some(Hit {
        distance,
        point: origin + dir * distance,
        instance_id: tri.instance_id,
        normal: (tri.b - tri.a).cross(tri.c - tri.a).normalize(),
    })
}

/// A two-level scene. Geometry is stored once per mesh, rather than once per
/// world instance (the Belmont trees expand 2.2M triangles into 266M).
///
/// Local-space bounds only reject candidates. Leaf intersections still use
/// the original world-space vertices and arithmetic, including world normals.
#[derive(Debug, Clone, Default)]
pub struct InstancedScene {
    meshes: Vec<std::sync::Arc<RaycastScene>>,
    instances: Vec<MeshInstance>,
    nodes: Vec<Node>,
}

#[derive(Debug, Clone)]
struct MeshInstance {
    mesh: usize,
    world: Mat4,
    inverse: Mat4,
    min: Vec3,
    max: Vec3,
    instance_id: u32,
    /// Insertion order: the last tie-break when several instances share an
    /// instance id (every mesh node of one actor model does), so exact
    /// depth ties never depend on traversal order.
    order: u32,
}

/// A prebuilt bottom-level mesh tree in its own (model-local) space, shared
/// by reference between instance scenes. Built once per mesh asset and
/// reused every tick: a per-tick [`InstancedScene`] over cached `Blas`es only
/// rebuilds the instance (top-level) tree, never the triangles.
#[derive(Debug, Clone)]
pub struct Blas(std::sync::Arc<RaycastScene>);

impl Blas {
    /// Build a mesh tree from model-local triangles. The triangles'
    /// `instance_id` is ignored: hits report the instance's id.
    pub fn build(tris: impl IntoIterator<Item = Tri>) -> Self {
        let mut mesh = RaycastScene::new();
        for tri in tris {
            mesh.push_tri(tri);
        }
        mesh.build();
        // Roundoff allowance is a property of the bounds, not work to repeat
        // for every node visited by every beam.
        for node in &mut mesh.nodes {
            // Covers the ray's local-space rounding and the positional error
            // an accepted hit can have (see MIN_INCIDENCE_COS): a tree must
            // never cull a triangle the exact leaf test would accept.
            let slack = node.min.abs().max(node.max.abs()) * 1e-5 + Vec3::splat(5e-2);
            node.min -= slack;
            node.max += slack;
        }
        Self(std::sync::Arc::new(mesh))
    }

    pub fn tri_count(&self) -> usize {
        self.0.tri_count()
    }

    /// The tree's model-local triangles, in leaf order.
    pub fn tris(&self) -> &[Tri] {
        &self.0.tris
    }

    /// Whether two handles share one built tree (cache tests).
    pub fn ptr_eq(&self, other: &Blas) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl InstancedScene {
    pub fn new() -> Self {
        Self::default()
    }

    /// Geometry and transforms for the optional hardware ray-query backend.
    /// BLAS triangle order is exactly the CPU leaf order; no world-space soup.
    pub(crate) fn gpu_meshes(&self) -> impl Iterator<Item = &[Tri]> {
        self.meshes.iter().map(|mesh| mesh.tris.as_slice())
    }

    pub(crate) fn gpu_instances(&self) -> impl Iterator<Item = (usize, Mat4, u32)> + '_ {
        self.instances
            .iter()
            .map(|instance| (instance.mesh, instance.world, instance.instance_id))
    }

    /// Every instance in the order [`Self::cast`] indexes them (after
    /// [`Self::build`]): `(mesh, world, instance_id, order)`. The hardware
    /// ray backend (`crate::gpu_rays`) mirrors exactly this table.
    pub(crate) fn instance_records(&self) -> impl Iterator<Item = (usize, Mat4, u32, u32)> + '_ {
        self.instances.iter().map(|instance| {
            (
                instance.mesh,
                instance.world,
                instance.instance_id,
                instance.order,
            )
        })
    }

    /// The hit [`Self::cast`] reports for triangle `triangle_index` of
    /// instance `instance_index` at distance `t` along `origin + t * dir`:
    /// one constructor shared by the CPU walk and the hardware ray backend,
    /// so normals and points are the same bytes whichever found the winner.
    pub fn hit_from(
        &self,
        instance_index: usize,
        triangle_index: usize,
        origin: Vec3,
        dir: Vec3,
        t: f32,
    ) -> Hit {
        let instance = &self.instances[instance_index];
        let tri = transformed_triangle(&self.meshes[instance.mesh].tris[triangle_index], instance);
        Hit {
            distance: t,
            point: origin + dir * t,
            instance_id: instance.instance_id,
            normal: (tri.b - tri.a).cross(tri.c - tri.a).normalize(),
        }
    }

    pub(crate) fn gpu_hit_triangle(&self, instance: usize, primitive: usize) -> Tri {
        let instance = &self.instances[instance];
        transformed_triangle(&self.meshes[instance.mesh].tris[primitive], instance)
    }

    pub(crate) fn closest_triangle_in_instance(
        &self,
        id: u32,
        origin: Vec3,
        dir: Vec3,
    ) -> Option<Tri> {
        let instance = self
            .instances
            .iter()
            .find(|instance| instance.instance_id == id)?;
        self.meshes[instance.mesh]
            .tris
            .iter()
            .map(|tri| transformed_triangle(tri, instance))
            .filter_map(|tri| ray_tri_distance(origin, dir, &tri).map(|t| (tri, t)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(tri, _)| tri)
    }

    pub fn add_mesh(&mut self, mesh: RaycastScene) -> usize {
        self.add_blas(&Blas::build(mesh.tris))
    }

    /// Reference a prebuilt mesh tree (no triangle work).
    pub fn add_blas(&mut self, blas: &Blas) -> usize {
        let index = self.meshes.len();
        self.meshes.push(blas.0.clone());
        index
    }

    pub fn add_instance(&mut self, mesh: usize, world: Mat4, instance_id: u32) {
        let Some(root) = self.meshes[mesh].nodes.first() else {
            return;
        };
        let (min, max) = transformed_bounds(root.min, root.max, world);
        let order = self.instances.len() as u32;
        self.instances.push(MeshInstance {
            mesh,
            world,
            inverse: world.inverse(),
            min,
            max,
            instance_id,
            order,
        });
    }

    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    pub fn tri_count(&self) -> usize {
        self.instances
            .iter()
            .map(|i| self.meshes[i.mesh].tri_count())
            .sum()
    }

    pub fn unique_tri_count(&self) -> usize {
        self.meshes.iter().map(|mesh| mesh.tri_count()).sum()
    }

    pub fn build(&mut self) {
        self.nodes.clear();
        if !self.instances.is_empty() {
            self.nodes.reserve(self.instances.len() * 2);
            self.subdivide(0, self.instances.len() as u32);
        }
    }

    fn subdivide(&mut self, first: u32, count: u32) -> u32 {
        let slice = &mut self.instances[first as usize..(first + count) as usize];
        let mut min = Vec3::splat(f32::MAX);
        let mut max = Vec3::splat(f32::MIN);
        for instance in slice.iter() {
            min = min.min(instance.min);
            max = max.max(instance.max);
        }
        let index = self.nodes.len() as u32;
        if count <= 4 {
            self.nodes.push(Node {
                min,
                max,
                left_first: first,
                count,
                right: 0,
            });
            return index;
        }
        let extent = max - min;
        let axis = if extent.x >= extent.y && extent.x >= extent.z {
            0
        } else if extent.y >= extent.z {
            1
        } else {
            2
        };
        let mid = count / 2;
        slice.select_nth_unstable_by(mid as usize, |a, b| {
            (a.min[axis] + a.max[axis])
                .total_cmp(&(b.min[axis] + b.max[axis]))
                .then(a.instance_id.cmp(&b.instance_id))
                .then(a.order.cmp(&b.order))
        });
        self.nodes.push(Node {
            min,
            max,
            left_first: 0,
            count: 0,
            right: 0,
        });
        let left = self.subdivide(first, mid);
        let right = self.subdivide(first + mid, count - mid);
        self.nodes[index as usize].left_first = left;
        self.nodes[index as usize].right = right;
        index
    }

    pub fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit> {
        self.cast_indexed(origin, dir, t_max)
            .map(|(instance_index, triangle_index, t)| {
                self.hit_from(instance_index, triangle_index, origin, dir, t)
            })
    }

    /// Local bounds of mesh `mesh` (its tree's root, slack included).
    pub(crate) fn mesh_bounds(&self, mesh: usize) -> (Vec3, Vec3) {
        self.meshes[mesh]
            .nodes
            .first()
            .map_or((Vec3::ZERO, Vec3::ZERO), |root| (root.min, root.max))
    }

    /// Test/diagnostic view of [`Self::instance_records`].
    #[doc(hidden)]
    pub fn instance_records_pub(&self) -> impl Iterator<Item = (usize, Mat4, u32, u32)> + '_ {
        self.instance_records()
    }

    /// Test/diagnostic: the local triangle `triangle_index` of the mesh of
    /// instance `instance_index`.
    #[doc(hidden)]
    pub fn mesh_triangle_pub(&self, instance_index: usize, triangle_index: usize) -> Tri {
        self.meshes[self.instances[instance_index].mesh].tris[triangle_index]
    }

    /// [`Self::cast`]'s winner as `(instance index, triangle index, t)`
    /// (indices as [`Self::hit_from`] takes them).
    pub fn cast_indexed(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<(usize, usize, f32)> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut best: Option<(usize, usize)> = None;
        let mut best_t = t_max;
        let inv_dir = dir.recip();
        let mut stack = [(0u32, 0.0f32); 64];
        // Reuse this stack across instances: no per-instance zero-fill.
        let mut local_stack = [(0u32, 0.0f32); 64];
        let mut sp = 1;
        while sp > 0 {
            sp -= 1;
            let (index, near) = stack[sp];
            if near > best_t {
                continue;
            }
            let node = &self.nodes[index as usize];
            if node.count == 0 {
                push_near_children(
                    &self.nodes,
                    node,
                    origin,
                    inv_dir,
                    best_t,
                    &mut stack,
                    &mut sp,
                );
                continue;
            }
            for instance_index in node.left_first as usize..(node.left_first + node.count) as usize
            {
                let instance = &self.instances[instance_index];
                if !ray_aabb(origin, inv_dir, best_t, instance.min, instance.max) {
                    continue;
                }
                let mesh = &self.meshes[instance.mesh];
                let local_origin = instance.inverse.transform_point3(origin);
                let local_inv = instance.inverse.transform_vector3(dir).recip();
                local_stack[0] = (0, 0.0);
                let mut local_sp = 1;
                while local_sp > 0 {
                    local_sp -= 1;
                    let (local_index, local_near) = local_stack[local_sp];
                    if local_near > best_t + 1e-3 {
                        continue;
                    }
                    let local = &mesh.nodes[local_index as usize];
                    if local.count == 0 {
                        push_near_children(
                            &mesh.nodes,
                            local,
                            local_origin,
                            local_inv,
                            best_t + 1e-3,
                            &mut local_stack,
                            &mut local_sp,
                        );
                        continue;
                    }
                    for triangle_index in
                        local.left_first as usize..(local.left_first + local.count) as usize
                    {
                        let tri = &mesh.tris[triangle_index];
                        let world_tri = transformed_triangle(tri, instance);
                        if let Some(distance) = ray_tri_distance(origin, dir, &world_tri) {
                            // A nearest-first walk must not make exact depth
                            // ties depend on visitation order.
                            let wins_tie = distance == best_t
                                && best.is_some_and(|(old_instance, old_tri)| {
                                    let old = &self.instances[old_instance];
                                    (instance.instance_id, triangle_index, instance.order)
                                        < (old.instance_id, old_tri, old.order)
                                });
                            if distance < best_t || wins_tie {
                                best_t = distance;
                                best = Some((instance_index, triangle_index));
                            }
                        }
                    }
                }
            }
        }
        best.map(|(instance_index, triangle_index)| (instance_index, triangle_index, best_t))
    }
}

impl Raycast for InstancedScene {
    fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit> {
        InstancedScene::cast(self, origin, dir, t_max)
    }
}

fn transformed_bounds(min: Vec3, max: Vec3, world: Mat4) -> (Vec3, Vec3) {
    let mut out_min = Vec3::splat(f32::MAX);
    let mut out_max = Vec3::splat(f32::MIN);
    for x in [min.x, max.x] {
        for y in [min.y, max.y] {
            for z in [min.z, max.z] {
                let point = world.transform_point3(Vec3::new(x, y, z));
                out_min = out_min.min(point);
                out_max = out_max.max(point);
            }
        }
    }
    let slack = out_min.abs().max(out_max.abs()) * 1e-6 + Vec3::splat(1e-4);
    (out_min - slack, out_max + slack)
}

fn transformed_triangle(tri: &Tri, instance: &MeshInstance) -> Tri {
    Tri {
        a: instance.world.transform_point3(tri.a),
        b: instance.world.transform_point3(tri.b),
        c: instance.world.transform_point3(tri.c),
        instance_id: instance.instance_id,
    }
}

fn ray_aabb_near(origin: Vec3, inv_dir: Vec3, t_max: f32, node: &Node) -> Option<f32> {
    let mut near = f32::NEG_INFINITY;
    let mut far = f32::INFINITY;
    for axis in 0..3 {
        let mut a = (node.min[axis] - origin[axis]) * inv_dir[axis];
        let mut b = (node.max[axis] - origin[axis]) * inv_dir[axis];
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        near = near.max(a);
        far = far.min(b);
        if near > far {
            return None;
        }
    }
    (far >= 0.0 && near <= t_max).then_some(near.max(0.0))
}

fn push_near_children(
    nodes: &[Node],
    node: &Node,
    origin: Vec3,
    inv_dir: Vec3,
    t_max: f32,
    stack: &mut [(u32, f32); 64],
    sp: &mut usize,
) {
    let left = ray_aabb_near(origin, inv_dir, t_max, &nodes[node.left_first as usize]);
    let right = ray_aabb_near(origin, inv_dir, t_max, &nodes[node.right as usize]);
    match (left, right) {
        (Some(a), Some(b)) => {
            let (near, far) = if a <= b {
                ((node.left_first, a), (node.right, b))
            } else {
                ((node.right, b), (node.left_first, a))
            };
            stack[*sp] = far;
            stack[*sp + 1] = near;
            *sp += 2;
        }
        (Some(a), None) => {
            stack[*sp] = (node.left_first, a);
            *sp += 1;
        }
        (None, Some(b)) => {
            stack[*sp] = (node.right, b);
            *sp += 1;
        }
        (None, None) => {}
    }
}

/// Nearest hit across immutable static geometry and a per-tick actor tree.
/// Layers are ordered; an equal-distance hit retains the earlier layer.
pub struct CompositeScene<'a> {
    layers: Vec<&'a dyn Raycast>,
}

impl<'a> CompositeScene<'a> {
    pub fn new(layers: Vec<&'a dyn Raycast>) -> Self {
        Self { layers }
    }
}

impl Raycast for CompositeScene<'_> {
    fn cast(&self, origin: Vec3, dir: Vec3, t_max: f32) -> Option<Hit> {
        let mut best = None;
        let mut best_t = t_max;
        for layer in &self.layers {
            if let Some(hit) = layer.cast(origin, dir, best_t) {
                if hit.distance < best_t {
                    best_t = hit.distance;
                    best = Some(hit);
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod parallel_build_tests {
    use super::*;

    /// Deterministic pseudo-random soup with duplicated centroids and
    /// duplicated triangles (the cases a sort or split could reorder).
    fn soup(n: usize) -> Vec<Tri> {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            ((state >> 40) as f32) / (1u64 << 24) as f32
        };
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let base = Vec3::new(next() * 500.0, next() * 20.0, next() * 500.0);
            let base = if i % 7 == 0 {
                Vec3::new(10.0, 0.0, 10.0)
            } else {
                base
            };
            let tri = Tri {
                a: base,
                b: base + Vec3::new(next(), 0.1, 0.0),
                c: base + Vec3::new(0.0, next(), 1.0),
                instance_id: (i % 97) as u32,
            };
            out.push(tri);
            if i % 11 == 0 {
                out.push(tri);
            }
        }
        out
    }

    fn scene(tris: &[Tri]) -> RaycastScene {
        let mut scene = RaycastScene::new();
        for t in tris {
            scene.push_tri(*t);
        }
        scene
    }

    #[test]
    fn parallel_build_reproduces_the_serial_tree_exactly() {
        for n in [0, 1, 5, 1_000, 300_000] {
            let tris = soup(n);
            let mut parallel = scene(&tris);
            parallel.build();
            let mut serial = scene(&tris);
            serial.build_serial();
            assert_eq!(parallel.nodes.len(), serial.nodes.len(), "n={n}");
            assert!(
                parallel.nodes == serial.nodes,
                "node layout differs at n={n}"
            );
            let same_tris = parallel.tris.iter().zip(&serial.tris).all(|(a, b)| {
                a.a == b.a && a.b == b.b && a.c == b.c && a.instance_id == b.instance_id
            });
            assert!(same_tris, "triangle order differs at n={n}");
            if n > 0 {
                assert_eq!(parallel.nodes.len(), node_count(parallel.tris.len()));
            }
        }
    }

    #[test]
    fn serialised_scene_restores_the_identical_tree_and_hits() {
        for n in [0, 1, 5, 50_000] {
            let mut built = scene(&soup(n));
            built.build();
            let mut bytes = Vec::new();
            built.write_to(&mut bytes).unwrap();
            assert_eq!(
                bytes.len(),
                24 + built.tris.len() * TRI_BYTES + built.nodes.len() * NODE_BYTES
            );
            let restored = RaycastScene::read_from(&mut bytes.as_slice()).unwrap();
            assert!(restored.nodes == built.nodes, "n={n}");
            assert!(restored.tris == built.tris, "n={n}");
            for k in 0..300 {
                let origin = Vec3::new((k * 7 % 500) as f32, 100.0, (k * 13 % 500) as f32);
                let a = built
                    .cast(origin, Vec3::NEG_Y, 1000.0)
                    .map(|h| (h.distance.to_bits(), h.instance_id));
                let b = restored
                    .cast(origin, Vec3::NEG_Y, 1000.0)
                    .map(|h| (h.distance.to_bits(), h.instance_id));
                assert_eq!(a, b);
            }
        }
        // A truncated or foreign file is rejected, never half-loaded.
        let mut built = scene(&soup(100));
        built.build();
        let mut bytes = Vec::new();
        built.write_to(&mut bytes).unwrap();
        assert!(RaycastScene::read_from(&mut &bytes[..bytes.len() - 1]).is_err());
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(RaycastScene::read_from(&mut extra.as_slice()).is_err());
        bytes[7] ^= 0xff;
        assert!(RaycastScene::read_from(&mut bytes.as_slice()).is_err());
    }

    #[test]
    fn parallel_build_hits_like_the_serial_build() {
        let tris = soup(200_000);
        let mut parallel = scene(&tris);
        parallel.build();
        let mut serial = scene(&tris);
        serial.build_serial();
        for k in 0..500 {
            let origin = Vec3::new((k * 7 % 500) as f32, 100.0, (k * 13 % 500) as f32);
            let a = parallel
                .cast(origin, Vec3::NEG_Y, 1000.0)
                .map(|h| (h.distance.to_bits(), h.instance_id));
            let b = serial
                .cast(origin, Vec3::NEG_Y, 1000.0)
                .map(|h| (h.distance.to_bits(), h.instance_id));
            assert_eq!(a, b);
        }
    }
}

#[cfg(test)]
mod shared_blas_tests {
    use super::*;
    use bevy::math::Quat;

    /// A closed, non-convex "car": a lower body box and a narrower cabin,
    /// so a beam over the hood misses where the bounding cuboid would hit.
    fn car_mesh() -> Vec<Tri> {
        fn cuboid(min: Vec3, max: Vec3, out: &mut Vec<Tri>) {
            let p = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
            let c = [
                p(min.x, min.y, min.z),
                p(max.x, min.y, min.z),
                p(max.x, max.y, min.z),
                p(min.x, max.y, min.z),
                p(min.x, min.y, max.z),
                p(max.x, min.y, max.z),
                p(max.x, max.y, max.z),
                p(min.x, max.y, max.z),
            ];
            for [a, b, d] in [
                [0, 1, 2],
                [0, 2, 3],
                [4, 6, 5],
                [4, 7, 6],
                [0, 4, 5],
                [0, 5, 1],
                [3, 2, 6],
                [3, 6, 7],
                [0, 3, 7],
                [0, 7, 4],
                [1, 5, 6],
                [1, 6, 2],
            ] {
                out.push(Tri {
                    a: c[a],
                    b: c[b],
                    c: c[d],
                    instance_id: 0,
                });
            }
        }
        let mut tris = Vec::new();
        cuboid(
            Vec3::new(-2.25, 0.3, -0.9),
            Vec3::new(2.25, 0.9, 0.9),
            &mut tris,
        );
        cuboid(
            Vec3::new(-1.2, 0.9, -0.8),
            Vec3::new(0.8, 1.5, 0.8),
            &mut tris,
        );
        tris
    }

    fn poses() -> Vec<(Mat4, u32)> {
        (0..12)
            .map(|k| {
                let k = k as f32;
                let world = Mat4::from_rotation_translation(
                    Quat::from_rotation_y(0.37 * k),
                    Vec3::new(
                        9.0 * (k % 4.0) - 12.0,
                        0.013 * k,
                        8.5 * (k / 4.0).floor() - 8.0,
                    ),
                );
                (world, 100 + k as u32)
            })
            .collect()
    }

    fn rays() -> Vec<(Vec3, Vec3)> {
        let origin = Vec3::new(0.3, 1.9, 0.2);
        let mut out = Vec::new();
        for ch in 0..32 {
            let elevation = (-25.0 + 30.0 * ch as f32 / 31.0_f32).to_radians();
            for step in 0..720 {
                let azimuth = (step as f32 / 720.0) * std::f32::consts::TAU;
                out.push((
                    origin,
                    Vec3::new(
                        elevation.cos() * azimuth.cos(),
                        elevation.sin(),
                        elevation.cos() * azimuth.sin(),
                    ),
                ));
            }
        }
        out
    }

    #[test]
    fn instanced_shared_blas_hits_exactly_like_world_space_triangles() {
        let blas = Blas::build(car_mesh());
        let mut instanced = InstancedScene::new();
        let slot = instanced.add_blas(&blas);
        let mut flat = RaycastScene::new();
        for (world, id) in poses() {
            instanced.add_instance(slot, world, id);
            for tri in car_mesh() {
                flat.push_tri(Tri {
                    a: world.transform_point3(tri.a),
                    b: world.transform_point3(tri.b),
                    c: world.transform_point3(tri.c),
                    instance_id: id,
                });
            }
        }
        instanced.build();
        flat.build();
        let mut hits = 0;
        for (origin, dir) in rays() {
            let a = instanced.cast(origin, dir, 120.0).map(|h| {
                (
                    h.distance.to_bits(),
                    h.instance_id,
                    h.normal.to_array().map(f32::to_bits),
                )
            });
            let b = flat.cast(origin, dir, 120.0).map(|h| {
                (
                    h.distance.to_bits(),
                    h.instance_id,
                    h.normal.to_array().map(f32::to_bits),
                )
            });
            assert_eq!(a, b, "ray {origin:?} {dir:?}");
            hits += usize::from(a.is_some());
        }
        assert!(
            hits > 500,
            "the fixture must actually hit the cars ({hits})"
        );
    }

    #[test]
    fn per_tick_instance_scenes_share_one_blas() {
        let blas = Blas::build(car_mesh());
        let mut first = InstancedScene::new();
        let a = first.add_blas(&blas);
        first.add_instance(a, Mat4::IDENTITY, 7);
        first.build();
        let mut second = InstancedScene::new();
        let b = second.add_blas(&blas);
        second.add_instance(b, Mat4::from_translation(Vec3::new(3.0, 0.0, 0.0)), 7);
        second.build();
        assert!(
            first.meshes[0].as_ref() as *const RaycastScene
                == second.meshes[0].as_ref() as *const RaycastScene
        );
        assert_eq!(first.unique_tri_count(), 24);
        // The moved instance is hit at the moved position.
        let down = Vec3::NEG_Y;
        assert!(first.cast(Vec3::new(0.0, 5.0, 0.0), down, 10.0).is_some());
        let moved = second.cast(Vec3::new(3.0, 5.0, 0.0), down, 10.0).unwrap();
        assert!((moved.point.y - 1.5).abs() < 1e-5);
    }

    #[test]
    fn mesh_geometry_is_not_its_bounding_box() {
        // Over the hood (x = 1.8, below the cabin roof line) a beam reaches
        // the hood at y = 0.9; the old cuboid proxy reported the box top.
        let blas = Blas::build(car_mesh());
        let mut scene = InstancedScene::new();
        let slot = scene.add_blas(&blas);
        scene.add_instance(slot, Mat4::IDENTITY, 1);
        scene.build();
        let hit = scene
            .cast(Vec3::new(1.8, 5.0, 0.0), Vec3::NEG_Y, 10.0)
            .unwrap();
        assert!(
            (hit.point.y - 0.9).abs() < 1e-5,
            "hood hit at {}",
            hit.point.y
        );
        // A horizontal beam at cabin height in front of the cabin misses the
        // car entirely: a 4.5 x 1.5 box would have stopped it.
        assert!(scene
            .cast(Vec3::new(10.0, 1.2, 0.0), Vec3::NEG_X, 7.5)
            .is_none());
    }

    #[test]
    fn equal_instance_ids_break_depth_ties_by_insertion_order() {
        // Two coincident instances of one actor (e.g. duplicated mesh nodes):
        // the winner must not depend on which the traversal reaches first.
        let blas = Blas::build(car_mesh());
        let mut runs = Vec::new();
        for _ in 0..3 {
            let mut scene = InstancedScene::new();
            let slot = scene.add_blas(&blas);
            for _ in 0..5 {
                scene.add_instance(slot, Mat4::IDENTITY, 9);
            }
            scene.build();
            runs.push(
                rays()
                    .into_iter()
                    .map(|(o, d)| {
                        scene
                            .cast(o + Vec3::new(0.0, 0.0, 6.0), d, 50.0)
                            .map(|h| (h.distance.to_bits(), h.normal.to_array().map(f32::to_bits)))
                    })
                    .collect::<Vec<_>>(),
            );
        }
        assert_eq!(runs[0], runs[1]);
        assert_eq!(runs[1], runs[2]);
    }
}
