//! KTX2 header arithmetic shared by texture staging and residency, and the
//! JavaScript `Math` functions those planners use (V8's fdlibm ports, so a
//! mip level computed here is the level the TypeScript engine computes).

use std::io::Read;
use std::path::Path;

use super::error::{PlanError, PlanResult};

pub const MAGIC: [u8; 12] = [
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
];

/// The first `len` bytes of a file, zero-padded when it is shorter (what
/// Node's `handle.read` into a zeroed `Buffer.alloc(len)` yields).
pub fn read_header(path: &Path, len: usize) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let mut out = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        let n = file.read(&mut out[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(out)
}

pub fn u32le(header: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(header[offset..offset + 4].try_into().expect("4 bytes"))
}

/// VkFormat values stored as RGBA8 (no 4x4 blocks).
pub fn is_rgba8(format: u32) -> bool {
    format == 37 || format == 43
}

/// Device bytes of one level.
pub fn level_bytes(format: u32, width: u64, height: u64) -> u64 {
    if is_rgba8(format) {
        width * height * 4
    } else {
        width.div_ceil(4) * height.div_ceil(4) * 16
    }
}

/// JavaScript `x >> n` for a uint32 below 2^31 (the shift count is masked).
pub fn shr(x: u32, n: u32) -> u64 {
    u64::from(x >> (n & 31))
}

/// `ktx2VramBytes`: device bytes of one KTX2 texture once resident, all mips.
pub fn vram_bytes(header: &[u8], uri: &str, variant: bool) -> PlanResult<u64> {
    if header.len() < 44 || header[..12] != MAGIC {
        return Err(PlanError::new("native_texture_ktx2_required", uri));
    }
    let format = u32le(header, 12);
    if variant && ![145, 146, 37, 43].contains(&format) {
        return Err(PlanError::new("native_ml_texture_format_invalid", format));
    }
    let mut width = u32le(header, 20);
    let mut height = u32le(header, 24);
    if variant && width.max(height) > 512 {
        return Err(PlanError::new(
            "native_ml_texture_dimensions_invalid",
            format!("{width}x{height}"),
        ));
    }
    let levels = u32le(header, 40);
    if width == 0 || height == 0 || levels == 0 || levels > 32 {
        return Err(PlanError::bare("native_texture_header_invalid"));
    }
    let mut bytes = 0;
    for _ in 0..levels {
        bytes += level_bytes(format, u64::from(width), u64::from(height));
        width = (width >> 1).max(1);
        height = (height >> 1).max(1);
    }
    Ok(bytes)
}

/// V8 `base::ieee754::log2` (FreeBSD `e_log2.c`): `Math.log2`. The
/// constants are fdlibm's, digit for digit.
#[allow(clippy::excessive_precision)]
pub fn js_log2(x: f64) -> f64 {
    const TWO54: f64 = 1.80143985094819840000e+16;
    const IVLN2HI: f64 = 1.44269504072144627571e+00;
    const IVLN2LO: f64 = 1.67517131648865118353e-10;
    const LG1: f64 = 6.666666666666735130e-01;
    const LG2: f64 = 3.999999999940941908e-01;
    const LG3: f64 = 2.857142874366239149e-01;
    const LG4: f64 = 2.222219843214978396e-01;
    const LG5: f64 = 1.818357216161805012e-01;
    const LG6: f64 = 1.531383769920937332e-01;
    const LG7: f64 = 1.479819860511658591e-01;
    let high = |v: f64| (v.to_bits() >> 32) as u32;
    let with_high =
        |v: f64, h: u32| f64::from_bits((u64::from(h) << 32) | (v.to_bits() & 0xffff_ffff));
    let mut x = x;
    let mut hx = high(x) as i32;
    let lx = x.to_bits() as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x) as i32;
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    if hx == 0x3ff0_0000 && lx == 0 {
        return 0.0;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    x = with_high(x, (hx | (i ^ 0x3ff0_0000)) as u32);
    k += i >> 20;
    let y = f64::from(k);
    let f = x - 1.0;
    let hfsq = 0.5 * f * f;
    // k_log1p(f)
    let r = {
        let s = f / (2.0 + f);
        let z = s * s;
        let w = z * z;
        let t1 = w * (LG2 + w * (LG4 + w * LG6));
        let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
        s * (hfsq + (t2 + t1))
    };
    let hi = f64::from_bits((f - hfsq).to_bits() & 0xffff_ffff_0000_0000);
    let lo = (f - hi) - hfsq + r;
    let mut val_hi = hi * IVLN2HI;
    let mut val_lo = (lo + hi) * IVLN2LO + lo * IVLN2HI;
    let w = y + val_hi;
    val_lo += (y - w) + val_hi;
    val_hi = w;
    val_lo + val_hi
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn header(format: u32, width: u32, height: u32, levels: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 80];
        bytes[..12].copy_from_slice(&MAGIC);
        bytes[12..16].copy_from_slice(&format.to_le_bytes());
        bytes[20..24].copy_from_slice(&width.to_le_bytes());
        bytes[24..28].copy_from_slice(&height.to_le_bytes());
        bytes[36..40].copy_from_slice(&1u32.to_le_bytes());
        bytes[40..44].copy_from_slice(&levels.to_le_bytes());
        bytes
    }

    #[test]
    fn vram_bytes_counts_blocks_and_mips() {
        assert_eq!(
            vram_bytes(&header(0, 1024, 1024, 1), "a", false).unwrap(),
            1024 * 1024
        );
        assert_eq!(
            vram_bytes(&header(145, 16, 16, 5), "a", true).unwrap(),
            256 + 64 + 16 + 16 + 16
        );
        assert_eq!(
            vram_bytes(&header(37, 4, 2, 2), "a", true).unwrap(),
            4 * 2 * 4 + 2 * 4
        );
        assert_eq!(
            vram_bytes(&header(145, 1024, 8, 1), "a", true)
                .unwrap_err()
                .code,
            "native_ml_texture_dimensions_invalid"
        );
        assert_eq!(
            vram_bytes(&header(1, 8, 8, 1), "a", true).unwrap_err().code,
            "native_ml_texture_format_invalid"
        );
        assert_eq!(
            vram_bytes(&header(0, 8, 8, 33), "a", false)
                .unwrap_err()
                .code,
            "native_texture_header_invalid"
        );
        assert_eq!(
            vram_bytes(&[0u8; 80], "a", false).unwrap_err().message,
            "native_texture_ktx2_required: a"
        );
    }

    #[test]
    fn log2_matches_v8() {
        // Math.log2 in Node 22 (V8), printed with 17 significant digits.
        let cases: [(f64, u64); 6] = [
            (8.0, 3.0f64.to_bits()),
            (1.0, 0.0f64.to_bits()),
            (0.1, 0xc00a_934f_0979_a371),
            (3.0, 0x3ff9_5c01_a39f_bd68),
            (1e-310, 0xc090_1730_dabc_a5f6),
            (123456.789, 0x4030_e9e4_bf2a_1cb2),
        ];
        for (x, bits) in cases {
            assert_eq!(js_log2(x).to_bits(), bits, "log2({x}) = {}", js_log2(x));
        }
        assert!(js_log2(-1.0).is_nan());
        assert_eq!(js_log2(0.0), f64::NEG_INFINITY);
    }
}
