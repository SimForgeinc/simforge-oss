//! Per-job static mip residency (`docs/engineering/texture-residency.md`).
//!
//! A job's camera trajectory is known before the service starts, so the
//! platform computes, for every map texture, the finest mip level any
//! rendered pixel of the job can sample (from the map's ingest-built texel
//! densities and the closest camera approach) and hands the service a plan:
//! `{uri, dropLevels}` per texture. The service then loads each listed KTX2
//! without its `dropLevels` finest levels: the file is re-headed in memory
//! (smaller base size, fewer levels, the same level payloads) before Bevy's
//! loader sees it. Sampling a level the plan keeps reads the same texels as
//! before, so a plan that is conservative renders the same pixels with a
//! fraction of the texture memory and upload.
//!
//! The reader wraps the default file source; it only ever changes the bytes
//! of files the plan lists. A listed file that cannot be trimmed fails its
//! load (and so the job), and a listed file the scene never loads fails
//! readiness: the plan is never applied partially or silently.
use anyhow::{bail, ensure, Context, Result};
use bevy::asset::io::{
    file::FileAssetReader, AssetReader, AssetReaderError, PathStream, Reader, VecReader,
};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

pub const SCHEMA: &str = "simforge.texture-residency-plan.v1";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanImage {
    /// Image URI relative to the master glTF's directory (as the staged
    /// master names it).
    pub uri: String,
    /// Finest mip levels not uploaded (0 keeps the full chain).
    pub drop_levels: u32,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub schema: String,
    /// Digest of the plan's inputs, echoed in the service log.
    pub plan_sha256: String,
    pub images: Vec<PlanImage>,
}

impl Plan {
    pub fn load(path: &Path) -> Result<Self> {
        let plan: Plan = serde_json::from_slice(
            &std::fs::read(path)
                .with_context(|| format!("read texture residency plan {}", path.display()))?,
        )
        .with_context(|| format!("parse texture residency plan {}", path.display()))?;
        ensure!(
            plan.schema == SCHEMA,
            "texture residency plan {} has schema {:?}, expected {SCHEMA}",
            path.display(),
            plan.schema
        );
        Ok(plan)
    }
}

/// What the reader trims, keyed by asset path, and what it has served.
#[derive(Default)]
pub struct Table {
    drops: HashMap<PathBuf, u32>,
    served: Mutex<HashMap<PathBuf, Served>>,
}

#[derive(Debug, Clone, Copy)]
pub struct Served {
    pub dropped: u32,
    pub full_bytes: u64,
    pub resident_bytes: u64,
}

impl Table {
    /// Resolve a plan against the master it belongs to: every entry becomes
    /// the asset path the glTF loader will request for it.
    pub fn resolve(plan: &Plan, master: &Path) -> Result<Self> {
        let dir = master
            .parent()
            .with_context(|| format!("master {} has no directory", master.display()))?;
        let mut drops = HashMap::with_capacity(plan.images.len());
        for image in &plan.images {
            ensure!(
                !image.uri.contains("://") && !Path::new(&image.uri).is_absolute(),
                "texture residency plan uri {:?} is not relative to the master",
                image.uri
            );
            let asset = crate::platform::asset_path(&dir.join(&image.uri))?;
            if drops
                .insert(normalize(Path::new(&asset)), image.drop_levels)
                .is_some()
            {
                bail!("texture residency plan lists {:?} twice", image.uri);
            }
        }
        Ok(Self {
            drops,
            served: Mutex::new(HashMap::new()),
        })
    }

    pub fn planned(&self) -> usize {
        self.drops.len()
    }

    /// Entries the scene has loaded so far.
    pub fn served(&self) -> HashMap<PathBuf, Served> {
        self.served.lock().expect("residency served").clone()
    }

    /// Planned paths the scene never loaded.
    pub fn unserved(&self) -> Vec<PathBuf> {
        let served = self.served.lock().expect("residency served");
        let mut missing: Vec<PathBuf> = self
            .drops
            .keys()
            .filter(|path| !served.contains_key(*path))
            .cloned()
            .collect();
        missing.sort();
        missing
    }
}

/// Lexical normalisation (`a/./b/../c` → `a/c`): the glTF loader joins image
/// URIs onto the master's directory without touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The table the service installs once it has read its scene spec. The
/// reader is built with the `App`, before the spec is known, so it holds
/// this slot rather than the table itself.
pub type Slot = Arc<RwLock<Option<Arc<Table>>>>;

/// The default asset source with residency applied.
pub struct ResidencyReader {
    inner: FileAssetReader,
    slot: Slot,
}

impl ResidencyReader {
    pub fn new(root: &str, slot: Slot) -> Self {
        Self {
            inner: FileAssetReader::new(root),
            slot,
        }
    }
}

impl AssetReader for ResidencyReader {
    async fn read<'a>(&'a self, path: &'a Path) -> Result<Box<dyn Reader + 'a>, AssetReaderError> {
        let table = self.slot.read().expect("residency slot").clone();
        let key = normalize(path);
        let Some((table, drop)) = table.and_then(|t| t.drops.get(&key).copied().map(|d| (t, d)))
        else {
            return Ok(Box::new(self.inner.read(path).await?));
        };
        let mut bytes = Vec::new();
        self.inner.read(path).await?.read_to_end(&mut bytes).await?;
        let full_bytes = level_payload_bytes(&bytes).map_err(|error| invalid(path, error))?;
        let trimmed = drop_levels(&bytes, drop).map_err(|error| invalid(path, error))?;
        let resident_bytes = level_payload_bytes(&trimmed).map_err(|error| invalid(path, error))?;
        table.served.lock().expect("residency served").insert(
            key,
            Served {
                dropped: drop,
                full_bytes,
                resident_bytes,
            },
        );
        Ok(Box::new(VecReader::new(trimmed)))
    }

    async fn read_meta<'a>(
        &'a self,
        path: &'a Path,
    ) -> Result<Box<dyn Reader + 'a>, AssetReaderError> {
        Ok(Box::new(self.inner.read_meta(path).await?))
    }

    async fn read_directory<'a>(
        &'a self,
        path: &'a Path,
    ) -> Result<Box<PathStream>, AssetReaderError> {
        self.inner.read_directory(path).await
    }

    async fn is_directory<'a>(&'a self, path: &'a Path) -> Result<bool, AssetReaderError> {
        self.inner.is_directory(path).await
    }
}

fn invalid(path: &Path, error: anyhow::Error) -> AssetReaderError {
    AssetReaderError::Io(Arc::new(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!(
            "[native_texture_residency_invalid] {}: {error:#}",
            path.display()
        ),
    )))
}

const KTX2_IDENTIFIER: [u8; 12] = [
    0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A,
];
const HEADER_BYTES: usize = 80;
const LEVEL_INDEX_BYTES: usize = 24;

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("4 bytes"))
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("8 bytes"))
}

/// Sum of the (uncompressed) level payloads: the bytes a KTX2 uploads.
pub fn level_payload_bytes(ktx2: &[u8]) -> Result<u64> {
    ensure!(
        ktx2.len() >= HEADER_BYTES && ktx2[..12] == KTX2_IDENTIFIER,
        "not a KTX2 file"
    );
    let levels = u32_at(ktx2, 40).max(1) as usize;
    ensure!(
        ktx2.len() >= HEADER_BYTES + levels * LEVEL_INDEX_BYTES,
        "truncated level index"
    );
    Ok((0..levels)
        .map(|level| u64_at(ktx2, HEADER_BYTES + level * LEVEL_INDEX_BYTES + 16))
        .sum())
}

/// The KTX2 without its `drop` finest mip levels: base size halved `drop`
/// times, the remaining levels' payloads (and their supercompression)
/// untouched, DFD and key/value data copied. Only single-image 2D textures
/// without supercompression global data (none or zstd/zlib per level, not
/// BasisLZ) can be trimmed; `drop` must leave at least one level.
pub fn drop_levels(ktx2: &[u8], drop: u32) -> Result<Vec<u8>> {
    if drop == 0 {
        return Ok(ktx2.to_vec());
    }
    ensure!(
        ktx2.len() >= HEADER_BYTES && ktx2[..12] == KTX2_IDENTIFIER,
        "not a KTX2 file"
    );
    let width = u32_at(ktx2, 20);
    let height = u32_at(ktx2, 24);
    let depth = u32_at(ktx2, 28);
    let layers = u32_at(ktx2, 32);
    let faces = u32_at(ktx2, 36);
    let levels = u32_at(ktx2, 40);
    let scheme = u32_at(ktx2, 44);
    let (dfd_offset, dfd_len) = (u32_at(ktx2, 48) as usize, u32_at(ktx2, 52) as usize);
    let (kvd_offset, kvd_len) = (u32_at(ktx2, 56) as usize, u32_at(ktx2, 60) as usize);
    let sgd_len = u64_at(ktx2, 72);
    ensure!(
        depth <= 1 && layers <= 1 && faces == 1,
        "only single-image 2D textures are trimmed ({width}x{height}x{depth}, {layers} layers, {faces} faces)"
    );
    ensure!(levels > drop, "cannot drop {drop} of {levels} levels");
    ensure!(
        matches!(scheme, 0 | 2 | 3) && sgd_len == 0,
        "supercompression scheme {scheme} (global data {sgd_len} bytes) cannot be trimmed per level"
    );
    ensure!(
        width >> drop > 0 || height >> drop > 0,
        "{width}x{height} has no level {drop}"
    );
    // A block-compressed texture's base size must be whole 4x4 blocks
    // (Basis/UASTC transcodes to BC; vkFormat 131..=156 are BC and ETC2).
    // ASTC's block sizes vary: not trimmed.
    let vk_format = u32_at(ktx2, 12);
    ensure!(
        !(157..=184).contains(&vk_format),
        "ASTC (vkFormat {vk_format}) is not trimmed"
    );
    if vk_format == 0 || (131..=156).contains(&vk_format) {
        ensure!(
            (width >> drop) % 4 == 0 && (height >> drop) % 4 == 0,
            "level {drop} of {width}x{height} is {}x{}, not whole 4x4 blocks",
            width >> drop,
            height >> drop
        );
    }
    let index = |level: usize| HEADER_BYTES + level * LEVEL_INDEX_BYTES;
    ensure!(
        ktx2.len() >= index(levels as usize),
        "truncated level index"
    );
    ensure!(
        dfd_offset + dfd_len <= ktx2.len() && kvd_offset + kvd_len <= ktx2.len(),
        "DFD or key/value data out of range"
    );
    let kept = (levels - drop) as usize;
    let mut payloads = Vec::with_capacity(kept);
    for level in drop as usize..levels as usize {
        let offset = u64_at(ktx2, index(level)) as usize;
        let length = u64_at(ktx2, index(level) + 8) as usize;
        let uncompressed = u64_at(ktx2, index(level) + 16);
        ensure!(offset + length <= ktx2.len(), "level {level} out of range");
        payloads.push((&ktx2[offset..offset + length], uncompressed));
    }
    let dfd = &ktx2[dfd_offset..dfd_offset + dfd_len];
    let kvd = &ktx2[kvd_offset..kvd_offset + kvd_len];
    // Level payloads align to lcm(texel block bytes, 4) without
    // supercompression; 48 is a multiple of every such lcm (4, 8, 12, 16).
    let align = if scheme == 0 { 48 } else { 1 };
    let new_dfd_offset = index(kept);
    let new_kvd_offset = new_dfd_offset + dfd.len();
    let mut cursor = new_kvd_offset + kvd.len();
    // Payloads are stored smallest level first; the index lists level 0 first.
    let mut offsets = vec![0usize; kept];
    for level in (0..kept).rev() {
        cursor = cursor.div_ceil(align) * align;
        offsets[level] = cursor;
        cursor += payloads[level].0.len();
    }
    let mut out = Vec::with_capacity(cursor);
    out.extend_from_slice(&ktx2[..20]); // identifier, vkFormat, typeSize
    for value in [
        (width >> drop).max(1),
        if height == 0 {
            0
        } else {
            (height >> drop).max(1)
        },
        depth,
        layers,
        faces,
        kept as u32,
        scheme,
        new_dfd_offset as u32,
        dfd.len() as u32,
        if kvd.is_empty() {
            0
        } else {
            new_kvd_offset as u32
        },
        kvd.len() as u32,
    ] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&0u64.to_le_bytes()); // sgd offset
    out.extend_from_slice(&0u64.to_le_bytes()); // sgd length
    for (level, (payload, uncompressed)) in payloads.iter().enumerate() {
        out.extend_from_slice(&(offsets[level] as u64).to_le_bytes());
        out.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        out.extend_from_slice(&uncompressed.to_le_bytes());
    }
    out.extend_from_slice(dfd);
    out.extend_from_slice(kvd);
    for level in (0..kept).rev() {
        out.resize(offsets[level], 0);
        out.extend_from_slice(payloads[level].0);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ktx2_variant::Supercompression;
    use bevy::image::{ktx2_buffer_to_image, CompressedImageFormats};

    /// A BC7 KTX2 with distinct bytes per level, via the variant writer's
    /// own path (UASTC is not needed: trimming is format-agnostic).
    fn bc7(width: u32, height: u32, levels: u32, zstd: bool) -> (Vec<u8>, Vec<Vec<u8>>) {
        let data: Vec<Vec<u8>> = (0..levels)
            .map(|level| {
                let (w, h) = ((width >> level).max(1), (height >> level).max(1));
                let n = (w.div_ceil(4) * h.div_ceil(4) * 16) as usize;
                (0..n)
                    .map(|i| (i as u8).wrapping_mul(31).wrapping_add(level as u8 * 17))
                    .collect()
            })
            .collect();
        let refs: Vec<&[u8]> = data.iter().map(Vec::as_slice).collect();
        let bytes = crate::ktx2_variant::write_ktx2_for_tests(
            width,
            height,
            &refs,
            if zstd {
                Supercompression::ZstdFastest
            } else {
                Supercompression::None
            },
        );
        (bytes, data)
    }

    #[test]
    fn dropping_levels_keeps_the_coarser_levels_bytes() {
        for zstd in [false, true] {
            let (source, levels) = bc7(64, 32, 7, zstd);
            // Levels 0..=3 are whole 4x4 blocks (64x32 .. 8x4).
            for drop in 0..4 {
                let trimmed = drop_levels(&source, drop).unwrap();
                let image = ktx2_buffer_to_image(&trimmed, CompressedImageFormats::BC, false)
                    .unwrap_or_else(|e| panic!("drop {drop} zstd {zstd}: {e:?}"));
                assert_eq!(image.texture_descriptor.size.width, (64u32 >> drop).max(1));
                assert_eq!(image.texture_descriptor.size.height, (32u32 >> drop).max(1));
                assert_eq!(image.texture_descriptor.mip_level_count, 7 - drop);
                assert_eq!(
                    image.data.unwrap(),
                    levels[drop as usize..].concat(),
                    "drop {drop}"
                );
                assert_eq!(
                    level_payload_bytes(&trimmed).unwrap(),
                    levels[drop as usize..]
                        .iter()
                        .map(|l| l.len() as u64)
                        .sum::<u64>()
                );
            }
            assert!(drop_levels(&source, 4).is_err(), "4x2 is not whole blocks");
            assert!(drop_levels(&source, 7).is_err(), "every level dropped");
        }
    }

    #[test]
    fn refuses_what_it_cannot_trim() {
        assert!(drop_levels(
            b"not a ktx2 file at all, not even close to eighty bytes long......",
            1
        )
        .is_err());
        let (mut source, _) = bc7(16, 16, 5, false);
        source[44..48].copy_from_slice(&1u32.to_le_bytes()); // BasisLZ
        assert!(drop_levels(&source, 1).is_err());
        // 24x24 BC7: level 1 is 12x12 (whole blocks), level 2 is 6x6 (not).
        let (source, _) = bc7(24, 24, 5, false);
        assert!(drop_levels(&source, 1).is_ok());
        assert!(drop_levels(&source, 2).is_err());
    }

    #[test]
    fn resolves_plan_uris_against_the_master() {
        let plan = Plan {
            schema: SCHEMA.into(),
            plan_sha256: "x".into(),
            images: vec![
                PlanImage {
                    uri: "images/a.ktx2".into(),
                    drop_levels: 2,
                },
                PlanImage {
                    uri: "derived/v/../v/objects/b.ktx2".into(),
                    drop_levels: 0,
                },
            ],
        };
        let table = Table::resolve(&plan, Path::new("/cache/tree/master.gltf")).unwrap();
        assert_eq!(
            table.drops.get(Path::new("cache/tree/images/a.ktx2")),
            Some(&2)
        );
        assert_eq!(
            table
                .drops
                .get(Path::new("cache/tree/derived/v/objects/b.ktx2")),
            Some(&0)
        );
        assert_eq!(table.unserved().len(), 2);
        let twice = Plan {
            images: vec![plan.images[0].clone(), plan.images[0].clone()],
            ..plan
        };
        assert!(Table::resolve(&twice, Path::new("/cache/tree/master.gltf")).is_err());
    }

    #[test]
    #[ignore = "reads a staged map closure"]
    fn every_closure_texture_trims_to_its_own_coarser_levels() {
        // SIMFORGE_KTX2_PROBE_DIR: every KTX2 under it, dropping 1..=3 levels,
        // must load (Bevy's loader, BC) to exactly the source's coarser levels.
        let dir = std::env::var("SIMFORGE_KTX2_PROBE_DIR").expect("SIMFORGE_KTX2_PROBE_DIR");
        let mut checked = 0;
        for entry in walk(Path::new(&dir)) {
            let source = std::fs::read(&entry).unwrap();
            let full = ktx2_buffer_to_image(&source, CompressedImageFormats::BC, false).unwrap();
            let levels = full.texture_descriptor.mip_level_count;
            let data = full.data.unwrap();
            let mut offset = 0usize;
            let mut starts = vec![];
            let block = full
                .texture_descriptor
                .format
                .block_copy_size(None)
                .unwrap() as usize;
            let (bw, bh) = full.texture_descriptor.format.block_dimensions();
            for level in 0..levels {
                starts.push(offset);
                let w = (full.texture_descriptor.size.width >> level).max(1);
                let h = (full.texture_descriptor.size.height >> level).max(1);
                offset += (w.div_ceil(bw) * h.div_ceil(bh)) as usize * block;
            }
            for drop in 1..levels.min(4) {
                let (w, h) = (
                    full.texture_descriptor.size.width >> drop,
                    full.texture_descriptor.size.height >> drop,
                );
                if w % 4 != 0 || h % 4 != 0 {
                    assert!(drop_levels(&source, drop).is_err());
                    continue;
                }
                let trimmed = ktx2_buffer_to_image(
                    &drop_levels(&source, drop).unwrap(),
                    CompressedImageFormats::BC,
                    false,
                )
                .unwrap();
                assert_eq!(
                    trimmed.data.unwrap(),
                    data[starts[drop as usize]..],
                    "{}",
                    entry.display()
                );
            }
            checked += 1;
        }
        eprintln!("{checked} textures trim to their own coarser levels");
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        let mut stack = vec![dir.to_path_buf()];
        while let Some(path) = stack.pop() {
            for entry in std::fs::read_dir(&path).unwrap() {
                let entry = entry.unwrap().path();
                if entry.is_dir() {
                    stack.push(entry);
                } else if entry.extension().is_some_and(|ext| ext == "ktx2") {
                    out.push(entry);
                }
            }
        }
        out.sort();
        out
    }
}
