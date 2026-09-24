//! Ingest-time GPU texture variants: UASTC KTX2 → the BC blocks Bevy would
//! transcode to at load, stored as a zstd-supercompressed KTX2 with a
//! concrete vkFormat, so the native service uploads them as they are.
//!
//! Byte identity is by construction: the blocks come from
//! [`bevy::image::ktx2_buffer_to_image`] with the BC formats the render
//! device supports, which is the loader's own path (`HIGH_QUALITY` UASTC
//! transcode, BC7 for RGB/RGBA, BC5 for RG, BC4 for R). Every variant is
//! verified before it is returned: loading it through the same function must
//! give exactly the bytes and format loading the source gives, for both
//! colour spaces.
use anyhow::{bail, ensure, Context, Result};
use bevy::image::{ktx2_buffer_to_image, CompressedImageFormats};
use bevy::render::render_resource::TextureFormat;

/// Identity of the generator: bump the last component when the output
/// layout or the transcode path changes (the pipeline keys variants on it).
pub const KTX2_GPU_VARIANT_TOOL: &str = "simforge.ktx2-gpu-variant/v1";

/// What one source image became.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantCodec {
    Bc7,
    Bc5,
    Bc4,
    /// Not a Basis/UASTC source (already a GPU or plain format): the loader
    /// does no transcode work for it, so the source is its own variant.
    Passthrough,
}

impl VariantCodec {
    pub fn as_str(&self) -> &'static str {
        match self {
            VariantCodec::Bc7 => "bc7",
            VariantCodec::Bc5 => "bc5",
            VariantCodec::Bc4 => "bc4",
            VariantCodec::Passthrough => "passthrough",
        }
    }
}

/// zstd supercompression of the variant's levels (lossless: the decoded
/// levels are the transcoded blocks either way).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Supercompression {
    None,
    /// ruzstd's `Fastest` (≈ zstd level 1). The pipeline may recompress the
    /// levels losslessly (e.g. `ktx compress --zstd 20`).
    ZstdFastest,
}

pub struct GpuVariant {
    pub codec: VariantCodec,
    /// Variant KTX2 bytes (`None` for [`VariantCodec::Passthrough`]).
    pub ktx2: Option<Vec<u8>>,
    pub vk_format: u32,
    pub width: u32,
    pub height: u32,
    pub levels: u32,
}

const KTX2_IDENTIFIER: [u8; 12] = [
    0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A,
];

/// (vkFormat, KDF colour model, samples as (bitOffset, bitLength-1, channel), block bytes)
fn layout(format: TextureFormat) -> Option<(VariantCodec, u32, u8, &'static [(u16, u8, u8)], u32)> {
    match format {
        TextureFormat::Bc7RgbaUnorm => Some((VariantCodec::Bc7, 145, 134, &[(0, 127, 0)], 16)),
        TextureFormat::Bc5RgUnorm => {
            Some((VariantCodec::Bc5, 141, 132, &[(0, 63, 0), (64, 63, 1)], 16))
        }
        TextureFormat::Bc4RUnorm => Some((VariantCodec::Bc4, 139, 131, &[(0, 63, 0)], 8)),
        _ => None,
    }
}

/// Build the variant of one KTX2 source (see the module docs).
pub fn gpu_variant(source: &[u8], supercompression: Supercompression) -> Result<GpuVariant> {
    let reader =
        ktx2::Reader::new(source).map_err(|error| anyhow::anyhow!("not a KTX2 file: {error:?}"))?;
    let header = reader.header();
    let (width, height, levels) = (
        header.pixel_width,
        header.pixel_height,
        header.level_count.max(1),
    );
    if header.format.is_some() {
        return Ok(GpuVariant {
            codec: VariantCodec::Passthrough,
            ktx2: None,
            vk_format: 0,
            width,
            height,
            levels,
        });
    }
    ensure!(
        header.pixel_depth <= 1 && header.layer_count <= 1 && header.face_count <= 1,
        "only single-layer 2D textures are map textures ({}x{}x{}, {} layers, {} faces)",
        width,
        height,
        header.pixel_depth,
        header.layer_count,
        header.face_count
    );
    let image = ktx2_buffer_to_image(source, CompressedImageFormats::BC, false)
        .context("transcode (Bevy loader path)")?;
    let format = image.texture_descriptor.format;
    let Some((codec, vk_format, color_model, samples, block_bytes)) = layout(format) else {
        bail!("the loader transcoded to {format:?}, which has no variant layout");
    };
    let data = image
        .data
        .as_ref()
        .context("transcoded image has no data")?;
    // Mip-major, level 0 first (`TextureDataOrder::MipMajor`).
    let mut level_data: Vec<&[u8]> = Vec::with_capacity(levels as usize);
    let mut offset = 0usize;
    for level in 0..levels {
        let (w, h) = ((width >> level).max(1), (height >> level).max(1));
        let bytes = (w.div_ceil(4) * h.div_ceil(4) * block_bytes) as usize;
        ensure!(
            offset + bytes <= data.len(),
            "transcoded data is shorter than its {levels} levels"
        );
        level_data.push(&data[offset..offset + bytes]);
        offset += bytes;
    }
    ensure!(
        offset == data.len(),
        "transcoded data has {} bytes beyond its levels",
        data.len() - offset
    );
    let ktx2 = write_ktx2(
        vk_format,
        color_model,
        samples,
        block_bytes,
        width,
        height,
        &level_data,
        supercompression,
    );
    // Verify: the variant loads to exactly what the source loads to.
    for srgb in [false, true] {
        let from_source = if srgb {
            ktx2_buffer_to_image(source, CompressedImageFormats::BC, true)?
        } else {
            image.clone()
        };
        let from_variant = ktx2_buffer_to_image(&ktx2, CompressedImageFormats::BC, srgb)
            .context("load the variant")?;
        ensure!(
            from_variant.texture_descriptor.format == from_source.texture_descriptor.format
                && from_variant.texture_descriptor.size == from_source.texture_descriptor.size
                && from_variant.texture_descriptor.mip_level_count
                    == from_source.texture_descriptor.mip_level_count
                && from_variant.data == from_source.data,
            "variant does not load to the source's blocks (srgb={srgb})"
        );
    }
    Ok(GpuVariant {
        codec,
        ktx2: Some(ktx2),
        vk_format,
        width,
        height,
        levels,
    })
}

/// A BC7 KTX2 of the given levels, for other modules' tests.
#[cfg(test)]
pub(crate) fn write_ktx2_for_tests(
    width: u32,
    height: u32,
    levels: &[&[u8]],
    supercompression: Supercompression,
) -> Vec<u8> {
    write_ktx2(
        145,
        134,
        &[(0, 127, 0)],
        16,
        width,
        height,
        levels,
        supercompression,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_ktx2(
    vk_format: u32,
    color_model: u8,
    samples: &[(u16, u8, u8)],
    block_bytes: u32,
    width: u32,
    height: u32,
    levels: &[&[u8]],
    supercompression: Supercompression,
) -> Vec<u8> {
    let stored: Vec<Vec<u8>> = levels
        .iter()
        .map(|level| match supercompression {
            Supercompression::None => level.to_vec(),
            Supercompression::ZstdFastest => ruzstd::encoding::compress_to_vec(
                *level,
                ruzstd::encoding::CompressionLevel::Fastest,
            ),
        })
        .collect();
    // Data Format Descriptor: one basic block (KDF 1.3), linear transfer
    // (colour space is the material's call, as for the UASTC source).
    let block_size = 24 + 16 * samples.len() as u32;
    let mut dfd = Vec::new();
    dfd.extend_from_slice(&(4 + block_size).to_le_bytes());
    dfd.extend_from_slice(&0u32.to_le_bytes()); // vendor 0 (Khronos), type 0 (basic)
    dfd.extend_from_slice(&2u16.to_le_bytes()); // version KDF 1.3
    dfd.extend_from_slice(&(block_size as u16).to_le_bytes());
    dfd.extend_from_slice(&[color_model, 1, 1, 0]); // model, BT.709 primaries, linear, straight alpha
    dfd.extend_from_slice(&[3, 3, 0, 0]); // 4x4x1x1 texel block
    let mut planes = [0u8; 8];
    planes[0] = block_bytes as u8;
    dfd.extend_from_slice(&planes);
    for &(bit_offset, bit_length, channel) in samples {
        dfd.extend_from_slice(&bit_offset.to_le_bytes());
        dfd.extend_from_slice(&[bit_length, channel]);
        dfd.extend_from_slice(&0u32.to_le_bytes()); // sample position
        dfd.extend_from_slice(&0u32.to_le_bytes()); // lower
        dfd.extend_from_slice(&u32::MAX.to_le_bytes()); // upper
    }
    let mut kvd = Vec::new();
    for (key, value) in [("KTXwriter", KTX2_GPU_VARIANT_TOOL)] {
        let entry = format!("{key}\0{value}\0");
        kvd.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        kvd.extend_from_slice(entry.as_bytes());
        while kvd.len() % 4 != 0 {
            kvd.push(0);
        }
    }
    let level_count = levels.len();
    let dfd_offset = 80 + 24 * level_count;
    let kvd_offset = dfd_offset + dfd.len();
    let mut data_offset = kvd_offset + kvd.len();
    // Uncompressed levels align to lcm(block bytes, 4); supercompressed to 1.
    let align = if supercompression == Supercompression::None {
        16
    } else {
        1
    };
    let mut out = Vec::new();
    out.extend_from_slice(&KTX2_IDENTIFIER);
    for value in [
        vk_format,
        1, // typeSize
        width,
        height,
        0, // depth
        0, // layers
        1, // faces
        level_count as u32,
        if supercompression == Supercompression::None {
            0
        } else {
            2
        },
        dfd_offset as u32,
        dfd.len() as u32,
        kvd_offset as u32,
        kvd.len() as u32,
    ] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&0u64.to_le_bytes()); // sgd offset
    out.extend_from_slice(&0u64.to_le_bytes()); // sgd length
                                                // Level data is stored smallest mip first; the index is level 0 first.
    let mut offsets = vec![0usize; level_count];
    for level in (0..level_count).rev() {
        data_offset = data_offset.div_ceil(align) * align;
        offsets[level] = data_offset;
        data_offset += stored[level].len();
    }
    for level in 0..level_count {
        out.extend_from_slice(&(offsets[level] as u64).to_le_bytes());
        out.extend_from_slice(&(stored[level].len() as u64).to_le_bytes());
        out.extend_from_slice(&(levels[level].len() as u64).to_le_bytes());
    }
    out.extend_from_slice(&dfd);
    out.extend_from_slice(&kvd);
    for level in (0..level_count).rev() {
        out.resize(offsets[level], 0);
        out.extend_from_slice(&stored[level]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every UASTC KTX2 of a staged closure (`SIMFORGE_KTX2_PROBE_DIR`) must
    /// produce a variant that loads to the source's exact blocks.
    #[test]
    #[ignore = "runs over a staged map closure"]
    fn every_closure_texture_has_a_byte_identical_variant() {
        let dir = std::env::var("SIMFORGE_KTX2_PROBE_DIR").expect("SIMFORGE_KTX2_PROBE_DIR");
        let mut files = Vec::new();
        let mut stack = vec![std::path::PathBuf::from(dir)];
        while let Some(path) = stack.pop() {
            for entry in std::fs::read_dir(&path).unwrap() {
                let entry = entry.unwrap().path();
                if entry.is_dir() {
                    stack.push(entry);
                } else if entry.extension().is_some_and(|ext| ext == "ktx2") {
                    files.push(entry);
                }
            }
        }
        let started = std::time::Instant::now();
        let totals = std::sync::Mutex::new((
            0usize,
            0usize,
            std::collections::BTreeMap::<&str, usize>::new(),
        ));
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..std::thread::available_parallelism().map_or(4, |n| n.get()) {
                scope.spawn(|| loop {
                    let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(path) = files.get(index) else { break };
                    let source = std::fs::read(path).unwrap();
                    let variant = gpu_variant(&source, Supercompression::ZstdFastest)
                        .unwrap_or_else(|error| panic!("{}: {error:#}", path.display()));
                    let mut totals = totals.lock().unwrap();
                    totals.0 += source.len();
                    totals.1 += variant.ktx2.as_ref().map_or(source.len(), Vec::len);
                    *totals.2.entry(variant.codec.as_str()).or_default() += 1;
                });
            }
        });
        let (source_bytes, variant_bytes, counts) = totals.into_inner().unwrap();
        eprintln!(
            "{} textures in {:.1} s: {counts:?}; source {:.2} GB -> variant {:.2} GB (zstd fastest)",
            files.len(),
            started.elapsed().as_secs_f64(),
            source_bytes as f64 / 1e9,
            variant_bytes as f64 / 1e9
        );
    }

    #[test]
    fn writes_a_parseable_ktx2_with_levels_smallest_first() {
        let levels: Vec<Vec<u8>> = vec![vec![1u8; 4 * 16], vec![2u8; 16]];
        let refs: Vec<&[u8]> = levels.iter().map(Vec::as_slice).collect();
        for compression in [Supercompression::None, Supercompression::ZstdFastest] {
            let bytes = write_ktx2(145, 134, &[(0, 127, 0)], 16, 8, 8, &refs, compression);
            let reader = ktx2::Reader::new(bytes.as_slice()).unwrap();
            assert_eq!(reader.header().format, Some(ktx2::Format::BC7_UNORM_BLOCK));
            assert_eq!(reader.header().level_count, 2);
            let image = ktx2_buffer_to_image(&bytes, CompressedImageFormats::BC, false).unwrap();
            assert_eq!(image.texture_descriptor.format, TextureFormat::Bc7RgbaUnorm);
            assert_eq!(
                image.data.unwrap(),
                [levels[0].clone(), levels[1].clone()].concat(),
                "{compression:?}"
            );
        }
    }
}
