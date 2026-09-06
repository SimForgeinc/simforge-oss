// Adapted from V8 12.4.254 src/base/ieee754.cc and src/builtins/math.tq.
// See the crate's THIRD_PARTY_NOTICES for the V8 redistribution terms.
//
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
//
// The original source has been modified significantly by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.
// Copyright 2014, the V8 project authors. All rights reserved.

//! Bit-exact ports of the elementary functions the frozen TypeScript engine
//! evaluated under V8.
//!
//! The conformance reference was produced by Node's V8 (12.4), whose `Math.*`
//! builtins are fdlibm ports (`src/base/ieee754.cc`, built without
//! `V8_USE_LIBM_TRIG_FUNCTIONS`) plus a Kahan-normalised `Math.hypot`
//! (`src/builtins/math.tq`). glibc's `sin`/`cos`/`atan2`/`hypot`/`cbrt`/`pow`
//! disagree with those in the last ULP on a few percent of inputs; a
//! reactive traffic population amplifies that noise into centimetres within
//! seconds. Every transcendental the engine evaluates on the tick path goes
//! through this module so both runtimes round identically.
//!
//! The code follows the C source statement for statement, including the
//! word-splitting tricks; only the special-value plumbing that relied on C
//! `volatile` to raise inexact flags is simplified, which never changes a
//! returned value. `sqrt`, `floor`, `ceil`, `trunc` and `%` are IEEE-exact in
//! both runtimes and are used from `std` directly.

#![allow(
    clippy::excessive_precision,
    clippy::many_single_char_names,
    clippy::unreadable_literal
)]

#[inline(always)]
fn high_word(d: f64) -> u32 {
    (d.to_bits() >> 32) as u32
}

#[inline(always)]
fn low_word(d: f64) -> u32 {
    d.to_bits() as u32
}

#[inline(always)]
fn words(d: f64) -> (u32, u32) {
    let bits = d.to_bits();
    ((bits >> 32) as u32, bits as u32)
}

#[inline(always)]
fn from_words(hi: u32, lo: u32) -> f64 {
    f64::from_bits(((hi as u64) << 32) | lo as u64)
}

#[inline(always)]
fn with_high_word(d: f64, hi: u32) -> f64 {
    f64::from_bits((d.to_bits() & 0x0000_0000_FFFF_FFFF) | ((hi as u64) << 32))
}

#[inline(always)]
fn with_low_word(d: f64, lo: u32) -> f64 {
    f64::from_bits((d.to_bits() & 0xFFFF_FFFF_0000_0000) | lo as u64)
}

/// `std::scalbn`: exact scaling by `2^n` (no rounding unless the result is
/// subnormal, which the callers only reach with exactly representable
/// values).
#[inline]
fn scalbn(x: f64, n: i32) -> f64 {
    let two54 = 1.80143985094819840000e+16f64;
    let twom54 = 5.55111512312578270212e-17f64;
    let huge = 1.0e+300f64;
    let tiny = 1.0e-300f64;
    let mut x = x;
    let mut hx = high_word(x);
    let lx = low_word(x);
    let mut k = ((hx & 0x7FF0_0000) >> 20) as i32;
    if k == 0 {
        if (lx | (hx & 0x7FFF_FFFF)) == 0 {
            return x;
        }
        x *= two54;
        hx = high_word(x);
        k = ((hx & 0x7FF0_0000) >> 20) as i32 - 54;
        if n < -50000 {
            return tiny * x;
        }
    }
    if k == 0x7FF {
        return x + x;
    }
    k += n;
    if k > 0x7FE {
        return huge * huge.copysign(x);
    }
    if k > 0 {
        return with_high_word(x, (hx & 0x800F_FFFF) | ((k as u32) << 20));
    }
    if k <= -54 {
        if n > 50000 {
            return huge * huge.copysign(x);
        }
        return tiny * tiny.copysign(x);
    }
    k += 54;
    x = with_high_word(x, (hx & 0x800F_FFFF) | ((k as u32) << 20));
    x * twom54
}

/* ------------------------------------------------------- argument reduction */

const TWO_OVER_PI: [i32; 66] = [
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163,
    0xABDEBB, 0xC561B7, 0x246E3A, 0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C,
    0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7, 0x8A5292,
    0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA,
    0x73A8C9, 0x60E27B, 0xC08C6B,
];

const NPIO2_HW: [i32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
    0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
    0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];

/// `__ieee754_rem_pio2`: `x rem pi/2` as `y[0] + y[1]`, returning `n`.
fn rem_pio2(x: f64, y: &mut [f64; 2]) -> i32 {
    let zero = 0.0f64;
    let half = 0.5f64;
    let two24 = 1.67772160000000000000e+07;
    let invpio2 = 6.36619772367581382433e-01;
    let pio2_1 = 1.57079632673412561417e+00;
    let pio2_1t = 6.07710050650619224932e-11;
    let pio2_2 = 6.07710050630396597660e-11;
    let pio2_2t = 2.02226624879595063154e-21;
    let pio2_3 = 2.02226624871116645580e-21;
    let pio2_3t = 8.47842766036889956997e-32;

    let hx = high_word(x) as i32;
    let ix = hx & 0x7FFF_FFFF;
    if ix <= 0x3FE921FB {
        y[0] = x;
        y[1] = 0.0;
        return 0;
    }
    if ix < 0x4002D97C {
        if hx > 0 {
            let mut z = x - pio2_1;
            if ix != 0x3FF921FB {
                y[0] = z - pio2_1t;
                y[1] = (z - y[0]) - pio2_1t;
            } else {
                z -= pio2_2;
                y[0] = z - pio2_2t;
                y[1] = (z - y[0]) - pio2_2t;
            }
            return 1;
        } else {
            let mut z = x + pio2_1;
            if ix != 0x3FF921FB {
                y[0] = z + pio2_1t;
                y[1] = (z - y[0]) + pio2_1t;
            } else {
                z += pio2_2;
                y[0] = z + pio2_2t;
                y[1] = (z - y[0]) + pio2_2t;
            }
            return -1;
        }
    }
    if ix <= 0x413921FB {
        let t = x.abs();
        let n = (t * invpio2 + half) as i32;
        let fn_ = n as f64;
        let mut r = t - fn_ * pio2_1;
        let mut w = fn_ * pio2_1t;
        if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
            y[0] = r - w;
        } else {
            let j = ix >> 20;
            y[0] = r - w;
            let high = high_word(y[0]);
            let mut i = j - ((high >> 20) & 0x7FF) as i32;
            if i > 16 {
                let t = r;
                w = fn_ * pio2_2;
                r = t - w;
                w = fn_ * pio2_2t - ((t - r) - w);
                y[0] = r - w;
                let high = high_word(y[0]);
                i = j - ((high >> 20) & 0x7FF) as i32;
                if i > 49 {
                    let t = r;
                    w = fn_ * pio2_3;
                    r = t - w;
                    w = fn_ * pio2_3t - ((t - r) - w);
                    y[0] = r - w;
                }
            }
        }
        y[1] = (r - y[0]) - w;
        if hx < 0 {
            y[0] = -y[0];
            y[1] = -y[1];
            return -n;
        }
        return n;
    }
    if ix >= 0x7FF0_0000 {
        y[0] = x - x;
        y[1] = y[0];
        return 0;
    }
    let low = low_word(x);
    let mut z = with_low_word(0.0, low);
    let e0 = (ix >> 20) - 1046;
    z = with_high_word(z, (ix - (((e0 as u32) << 20) as i32)) as u32);
    let mut tx = [0.0f64; 3];
    for slot in tx.iter_mut().take(2) {
        *slot = (z as i32) as f64;
        z = (z - *slot) * two24;
    }
    tx[2] = z;
    let mut nx = 3usize;
    while tx[nx - 1] == zero {
        nx -= 1;
    }
    let n = kernel_rem_pio2(&tx, y, e0, nx, 2);
    if hx < 0 {
        y[0] = -y[0];
        y[1] = -y[1];
        return -n;
    }
    n
}

const PIO2: [f64; 8] = [
    1.57079625129699707031e+00,
    7.54978941586159635335e-08,
    5.39030252995776476554e-15,
    3.28200341580791294123e-22,
    1.27065575308067607349e-29,
    1.22933308981111328932e-36,
    2.73370053816464559624e-44,
    2.16741683877804819444e-51,
];

/// `__kernel_rem_pio2` with `prec == 2` (the only precision the trig
/// functions request), `y` receiving two terms.
fn kernel_rem_pio2(x: &[f64; 3], y: &mut [f64; 2], e0: i32, nx: usize, prec: usize) -> i32 {
    const INIT_JK: [i32; 4] = [2, 3, 4, 6];
    let zero = 0.0f64;
    let one = 1.0f64;
    let two24 = 1.67772160000000000000e+07;
    let twon24 = 5.96046447753906250000e-08;

    let mut iq = [0i32; 20];
    let mut f = [0.0f64; 20];
    let mut fq = [0.0f64; 20];
    let mut q = [0.0f64; 20];

    let jk = INIT_JK[prec];
    let jp = jk;

    let jx = nx as i32 - 1;
    let mut jv = (e0 - 3) / 24;
    if jv < 0 {
        jv = 0;
    }
    let mut q0 = e0 - 24 * (jv + 1);

    let mut j = jv - jx;
    let m = jx + jk;
    for i in 0..=m {
        f[i as usize] = if j < 0 {
            zero
        } else {
            TWO_OVER_PI[j as usize] as f64
        };
        j += 1;
    }

    for i in 0..=jk {
        let mut fw = 0.0f64;
        for j in 0..=jx {
            fw += x[j as usize] * f[(jx + i - j) as usize];
        }
        q[i as usize] = fw;
    }

    let mut jz = jk;
    let mut z: f64;
    let mut n: i32;
    let mut ih: i32;
    loop {
        // distill q[] into iq[] reversingly
        let mut i = 0i32;
        let mut jj = jz;
        z = q[jz as usize];
        while jj > 0 {
            let fw = ((twon24 * z) as i32) as f64;
            iq[i as usize] = (z - two24 * fw) as i32;
            z = q[(jj - 1) as usize] + fw;
            i += 1;
            jj -= 1;
        }

        // compute n
        z = scalbn(z, q0);
        z -= 8.0 * (z * 0.125).floor();
        n = z as i32;
        z -= n as f64;
        ih = 0;
        if q0 > 0 {
            let i = iq[(jz - 1) as usize] >> (24 - q0);
            n += i;
            iq[(jz - 1) as usize] -= i << (24 - q0);
            ih = iq[(jz - 1) as usize] >> (23 - q0);
        } else if q0 == 0 {
            ih = iq[(jz - 1) as usize] >> 23;
        } else if z >= 0.5 {
            ih = 2;
        }

        if ih > 0 {
            n += 1;
            let mut carry = 0i32;
            for i in 0..jz {
                let j = iq[i as usize];
                if carry == 0 {
                    if j != 0 {
                        carry = 1;
                        iq[i as usize] = 0x100_0000 - j;
                    }
                } else {
                    iq[i as usize] = 0xFF_FFFF - j;
                }
            }
            if q0 > 0 {
                match q0 {
                    1 => iq[(jz - 1) as usize] &= 0x7F_FFFF,
                    2 => iq[(jz - 1) as usize] &= 0x3F_FFFF,
                    _ => {}
                }
            }
            if ih == 2 {
                z = one - z;
                if carry != 0 {
                    z -= scalbn(one, q0);
                }
            }
        }

        // check if recomputation is needed
        if z == zero {
            let mut j = 0i32;
            let mut i = jz - 1;
            while i >= jk {
                j |= iq[i as usize];
                i -= 1;
            }
            if j == 0 {
                let mut k = 1i32;
                while jk >= k && iq[(jk - k) as usize] == 0 {
                    k += 1;
                }
                for i in (jz + 1)..=(jz + k) {
                    f[(jx + i) as usize] = TWO_OVER_PI[(jv + i) as usize] as f64;
                    let mut fw = 0.0f64;
                    for j in 0..=jx {
                        fw += x[j as usize] * f[(jx + i - j) as usize];
                    }
                    q[i as usize] = fw;
                }
                jz += k;
                continue;
            }
        }
        break;
    }

    // chop off zero terms
    if z == 0.0 {
        jz -= 1;
        q0 -= 24;
        while iq[jz as usize] == 0 {
            jz -= 1;
            q0 -= 24;
        }
    } else {
        z = scalbn(z, -q0);
        if z >= two24 {
            let fw = ((twon24 * z) as i32) as f64;
            iq[jz as usize] = (z - two24 * fw) as i32;
            jz += 1;
            q0 += 24;
            iq[jz as usize] = fw as i32;
        } else {
            iq[jz as usize] = z as i32;
        }
    }

    // convert integer "bit" chunk to floating-point value
    let mut fw = scalbn(one, q0);
    let mut i = jz;
    while i >= 0 {
        q[i as usize] = fw * iq[i as usize] as f64;
        fw *= twon24;
        i -= 1;
    }

    // compute PIo2[0,...,jp]*q[jz,...,0]
    let mut i = jz;
    while i >= 0 {
        let mut fw = 0.0f64;
        let mut k = 0i32;
        while k <= jp && k <= jz - i {
            fw += PIO2[k as usize] * q[(i + k) as usize];
            k += 1;
        }
        fq[(jz - i) as usize] = fw;
        i -= 1;
    }

    // compress fq[] into y[] (prec 2)
    let mut fw = 0.0f64;
    let mut i = jz;
    while i >= 0 {
        fw += fq[i as usize];
        i -= 1;
    }
    y[0] = if ih == 0 { fw } else { -fw };
    let mut fw = fq[0] - fw;
    for i in 1..=jz {
        fw += fq[i as usize];
    }
    y[1] = if ih == 0 { fw } else { -fw };
    n & 7
}

/* -------------------------------------------------------------- kernels */

#[inline]
fn kernel_cos(x: f64, y: f64) -> f64 {
    let one = 1.0f64;
    let c1 = 4.16666666666666019037e-02;
    let c2 = -1.38888888888741095749e-03;
    let c3 = 2.48015872894767294178e-05;
    let c4 = -2.75573143513906633035e-07;
    let c5 = 2.08757232129817482790e-09;
    let c6 = -1.13596475577881948265e-11;

    let ix = (high_word(x) & 0x7FFF_FFFF) as i32;
    if ix < 0x3E40_0000 && (x as i32) == 0 {
        return one;
    }
    let z = x * x;
    let r = z * (c1 + z * (c2 + z * (c3 + z * (c4 + z * (c5 + z * c6)))));
    if ix < 0x3FD3_3333 {
        one - (0.5 * z - (z * r - x * y))
    } else {
        let qx = if ix > 0x3FE9_0000 {
            0.28125
        } else {
            from_words((ix - 0x0020_0000) as u32, 0)
        };
        let iz = 0.5 * z - qx;
        let a = one - qx;
        a - (iz - (z * r - x * y))
    }
}

#[inline]
fn kernel_sin(x: f64, y: f64, iy: i32) -> f64 {
    let half = 0.5f64;
    let s1 = -1.66666666666666324348e-01;
    let s2 = 8.33333333332248946124e-03;
    let s3 = -1.98412698298579493134e-04;
    let s4 = 2.75573137070700676789e-06;
    let s5 = -2.50507602534068634195e-08;
    let s6 = 1.58969099521155010221e-10;

    let ix = (high_word(x) & 0x7FFF_FFFF) as i32;
    if ix < 0x3E40_0000 && (x as i32) == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = s2 + z * (s3 + z * (s4 + z * (s5 + z * s6)));
    if iy == 0 {
        x + v * (s1 + z * r)
    } else {
        x - ((z * (half * y - v * r) - y) - v * s1)
    }
}

fn kernel_tan(x: f64, y: f64, iy: i32) -> f64 {
    const T: [f64; 13] = [
        3.33333333333334091986e-01,
        1.33333333333201242699e-01,
        5.39682539762260521377e-02,
        2.18694882948595424599e-02,
        8.86323982359930005737e-03,
        3.59207910759131235356e-03,
        1.45620945432529025516e-03,
        5.88041240820264096874e-04,
        2.46463134818469906812e-04,
        7.81794442939557092300e-05,
        7.14072491382608190305e-05,
        -1.85586374855275456654e-05,
        2.59073051863633712884e-05,
    ];
    let one = 1.0f64;
    let pio4 = 7.85398163397448278999e-01;
    let pio4lo = 3.06161699786838301793e-17;

    let mut x = x;
    let mut y = y;
    let hx = high_word(x) as i32;
    let ix = hx & 0x7FFF_FFFF;
    if ix < 0x3E30_0000 && (x as i32) == 0 {
        let low = low_word(x);
        if ((ix as u32 | low) | (iy + 1) as u32) == 0 {
            return one / x.abs();
        } else if iy == 1 {
            return x;
        } else {
            let w = x + y;
            let z = with_low_word(w, 0);
            let v = y - (z - x);
            let a = -one / w;
            let t = with_low_word(a, 0);
            let s = one + t * z;
            return t + a * (s + t * v);
        }
    }
    if ix >= 0x3FE5_9428 {
        if hx < 0 {
            x = -x;
            y = -y;
        }
        let z = pio4 - x;
        let w = pio4lo - y;
        x = z + w;
        y = 0.0;
    }
    let z = x * x;
    let w = z * z;
    let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
    let v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
    let s = z * x;
    let mut r = y + z * (s * (r + v) + y);
    r += T[0] * s;
    let w = x + r;
    if ix >= 0x3FE5_9428 {
        let v = iy as f64;
        return (1 - ((hx >> 30) & 2)) as f64 * (v - 2.0 * (x - (w * w / (w + v) - r)));
    }
    if iy == 1 {
        w
    } else {
        let z = with_low_word(w, 0);
        let v = r - (z - x);
        let a = -1.0 / w;
        let t = with_low_word(a, 0);
        let s = 1.0 + t * z;
        t + a * (s + t * v)
    }
}

/* ------------------------------------------------------------- public */

/// `Math.sin`.
pub fn sin(x: f64) -> f64 {
    let ix = (high_word(x) & 0x7FFF_FFFF) as i32;
    if ix <= 0x3FE9_21FB {
        kernel_sin(x, 0.0, 0)
    } else if ix >= 0x7FF0_0000 {
        x - x
    } else {
        let mut y = [0.0f64; 2];
        let n = rem_pio2(x, &mut y);
        match n & 3 {
            0 => kernel_sin(y[0], y[1], 1),
            1 => kernel_cos(y[0], y[1]),
            2 => -kernel_sin(y[0], y[1], 1),
            _ => -kernel_cos(y[0], y[1]),
        }
    }
}

/// `Math.cos`.
pub fn cos(x: f64) -> f64 {
    let ix = (high_word(x) & 0x7FFF_FFFF) as i32;
    if ix <= 0x3FE9_21FB {
        kernel_cos(x, 0.0)
    } else if ix >= 0x7FF0_0000 {
        x - x
    } else {
        let mut y = [0.0f64; 2];
        let n = rem_pio2(x, &mut y);
        match n & 3 {
            0 => kernel_cos(y[0], y[1]),
            1 => -kernel_sin(y[0], y[1], 1),
            2 => -kernel_cos(y[0], y[1]),
            _ => kernel_sin(y[0], y[1], 1),
        }
    }
}

/// `(Math.sin(x), Math.cos(x))`, sharing one argument reduction.
pub fn sin_cos(x: f64) -> (f64, f64) {
    let ix = (high_word(x) & 0x7FFF_FFFF) as i32;
    if ix <= 0x3FE9_21FB {
        (kernel_sin(x, 0.0, 0), kernel_cos(x, 0.0))
    } else if ix >= 0x7FF0_0000 {
        (x - x, x - x)
    } else {
        let mut y = [0.0f64; 2];
        let n = rem_pio2(x, &mut y);
        let s = kernel_sin(y[0], y[1], 1);
        let c = kernel_cos(y[0], y[1]);
        match n & 3 {
            0 => (s, c),
            1 => (c, -s),
            2 => (-s, -c),
            _ => (-c, s),
        }
    }
}

/// `Math.tan`.
pub fn tan(x: f64) -> f64 {
    let ix = (high_word(x) & 0x7FFF_FFFF) as i32;
    if ix <= 0x3FE9_21FB {
        kernel_tan(x, 0.0, 1)
    } else if ix >= 0x7FF0_0000 {
        x - x
    } else {
        let mut y = [0.0f64; 2];
        let n = rem_pio2(x, &mut y);
        kernel_tan(y[0], y[1], 1 - ((n & 1) << 1))
    }
}

/// `Math.atan`.
pub fn atan(x: f64) -> f64 {
    const ATANHI: [f64; 4] = [
        4.63647609000806093515e-01,
        7.85398163397448278999e-01,
        9.82793723247329054082e-01,
        1.57079632679489655800e+00,
    ];
    const ATANLO: [f64; 4] = [
        2.26987774529616870924e-17,
        3.06161699786838301793e-17,
        1.39033110312309984516e-17,
        6.12323399573676603587e-17,
    ];
    const AT: [f64; 11] = [
        3.33333333333329318027e-01,
        -1.99999999998764832476e-01,
        1.42857142725034663711e-01,
        -1.11111104054623557880e-01,
        9.09088713343650656196e-02,
        -7.69187620504482999495e-02,
        6.66107313738753120669e-02,
        -5.83357013379057348645e-02,
        4.97687799461593236017e-02,
        -3.65315727442169155270e-02,
        1.62858201153657823623e-02,
    ];
    let one = 1.0f64;
    let huge = 1.0e300f64;

    let mut x = x;
    let hx = high_word(x) as i32;
    let ix = hx & 0x7FFF_FFFF;
    if ix >= 0x4410_0000 {
        let low = low_word(x);
        if ix > 0x7FF0_0000 || (ix == 0x7FF0_0000 && low != 0) {
            return x + x;
        }
        return if hx > 0 {
            ATANHI[3] + ATANLO[3]
        } else {
            -ATANHI[3] - ATANLO[3]
        };
    }
    let id: i32;
    if ix < 0x3FDC_0000 {
        if ix < 0x3E40_0000 && huge + x > one {
            return x;
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3FF3_0000 {
            if ix < 0x3FE6_0000 {
                id = 0;
                x = (2.0 * x - one) / (2.0 + x);
            } else {
                id = 1;
                x = (x - one) / (x + one);
            }
        } else if ix < 0x4003_8000 {
            id = 2;
            x = (x - 1.5) / (one + 1.5 * x);
        } else {
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        x - x * (s1 + s2)
    } else {
        let z = ATANHI[id as usize] - ((x * (s1 + s2) - ATANLO[id as usize]) - x);
        if hx < 0 {
            -z
        } else {
            z
        }
    }
}

/// `Math.atan2(y, x)`.
pub fn atan2(y: f64, x: f64) -> f64 {
    let tiny = 1.0e-300f64;
    let zero = 0.0f64;
    let pi_o_4 = 7.8539816339744827900E-01;
    let pi_o_2 = 1.5707963267948965580E+00;
    let pi = 3.1415926535897931160E+00;
    let pi_lo = 1.2246467991473531772E-16;

    let (hx, lx) = words(x);
    let hx = hx as i32;
    let ix = hx & 0x7FFF_FFFF;
    let (hy, ly) = words(y);
    let hy = hy as i32;
    let iy = hy & 0x7FFF_FFFF;
    if (ix as u32 | ((lx | lx.wrapping_neg()) >> 31)) > 0x7FF0_0000
        || (iy as u32 | ((ly | ly.wrapping_neg()) >> 31)) > 0x7FF0_0000
    {
        return x + y;
    }
    if (hx.wrapping_sub(0x3FF0_0000) as u32 | lx) == 0 {
        return atan(y);
    }
    let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2);

    if (iy as u32 | ly) == 0 {
        return match m {
            0 | 1 => y,
            2 => pi + tiny,
            _ => -pi - tiny,
        };
    }
    if (ix as u32 | lx) == 0 {
        return if hy < 0 {
            -pi_o_2 - tiny
        } else {
            pi_o_2 + tiny
        };
    }
    if ix == 0x7FF0_0000 {
        if iy == 0x7FF0_0000 {
            return match m {
                0 => pi_o_4 + tiny,
                1 => -pi_o_4 - tiny,
                2 => 3.0 * pi_o_4 + tiny,
                _ => -3.0 * pi_o_4 - tiny,
            };
        } else {
            return match m {
                0 => zero,
                1 => -zero,
                2 => pi + tiny,
                _ => -pi - tiny,
            };
        }
    }
    if iy == 0x7FF0_0000 {
        return if hy < 0 {
            -pi_o_2 - tiny
        } else {
            pi_o_2 + tiny
        };
    }

    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        m &= 1;
        pi_o_2 + 0.5 * pi_lo
    } else if hx < 0 && k < -60 {
        0.0
    } else {
        atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => pi - (z - pi_lo),
        _ => (z - pi_lo) - pi,
    }
}

/// `Math.acos`.
pub fn acos(x: f64) -> f64 {
    let one = 1.0f64;
    let pi = 3.14159265358979311600e+00;
    let pio2_hi = 1.57079632679489655800e+00;
    let pio2_lo = 6.12323399573676603587e-17;
    let ps0 = 1.66666666666666657415e-01;
    let ps1 = -3.25565818622400915405e-01;
    let ps2 = 2.01212532134862925881e-01;
    let ps3 = -4.00555345006794114027e-02;
    let ps4 = 7.91534994289814532176e-04;
    let ps5 = 3.47933107596021167570e-05;
    let qs1 = -2.40339491173441421878e+00;
    let qs2 = 2.02094576023350569471e+00;
    let qs3 = -6.88283971605453293030e-01;
    let qs4 = 7.70381505559019352791e-02;

    let hx = high_word(x) as i32;
    let ix = hx & 0x7FFF_FFFF;
    if ix >= 0x3FF0_0000 {
        let lx = low_word(x);
        if ((ix - 0x3FF0_0000) as u32 | lx) == 0 {
            return if hx > 0 { 0.0 } else { pi + 2.0 * pio2_lo };
        }
        return f64::NAN;
    }
    if ix < 0x3FE0_0000 {
        if ix <= 0x3C60_0000 {
            return pio2_hi + pio2_lo;
        }
        let z = x * x;
        let p = z * (ps0 + z * (ps1 + z * (ps2 + z * (ps3 + z * (ps4 + z * ps5)))));
        let q = one + z * (qs1 + z * (qs2 + z * (qs3 + z * qs4)));
        let r = p / q;
        pio2_hi - (x - (pio2_lo - x * r))
    } else if hx < 0 {
        let z = (one + x) * 0.5;
        let p = z * (ps0 + z * (ps1 + z * (ps2 + z * (ps3 + z * (ps4 + z * ps5)))));
        let q = one + z * (qs1 + z * (qs2 + z * (qs3 + z * qs4)));
        let s = z.sqrt();
        let r = p / q;
        let w = r * s - pio2_lo;
        pi - 2.0 * (s + w)
    } else {
        let z = (one - x) * 0.5;
        let s = z.sqrt();
        let df = with_low_word(s, 0);
        let c = (z - df * df) / (s + df);
        let p = z * (ps0 + z * (ps1 + z * (ps2 + z * (ps3 + z * (ps4 + z * ps5)))));
        let q = one + z * (qs1 + z * (qs2 + z * (qs3 + z * qs4)));
        let r = p / q;
        let w = r * s + c;
        2.0 * (df + w)
    }
}

/// `Math.exp`.
pub fn exp(x: f64) -> f64 {
    let one = 1.0f64;
    let half = [0.5f64, -0.5f64];
    let o_threshold = 7.09782712893383973096e+02;
    let u_threshold = -7.45133219101941108420e+02;
    let ln2hi = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    let ln2lo = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    let invln2 = 1.44269504088896338700e+00;
    let p1 = 1.66666666666666019037e-01;
    let p2 = -2.77777777770155933842e-03;
    let p3 = 6.61375632143793436117e-05;
    let p4 = -1.65339022054652515390e-06;
    let p5 = 4.13813679705723846039e-08;
    let e = 2.718281828459045f64;
    let huge = 1.0e+300f64;
    let twom1000 = 9.33263618503218878990e-302;
    let two1023 = 8.988465674311579539e307;

    let mut x = x;
    let mut hi = 0.0f64;
    let mut lo = 0.0f64;
    let mut k = 0i32;
    let hx = high_word(x);
    let xsb = ((hx >> 31) & 1) as usize;
    let hx = hx & 0x7FFF_FFFF;

    if hx >= 0x4086_2E42 {
        if hx >= 0x7FF0_0000 {
            let lx = low_word(x);
            if ((hx & 0xF_FFFF) | lx) != 0 {
                return x + x;
            } else {
                return if xsb == 0 { x } else { 0.0 };
            }
        }
        if x > o_threshold {
            return huge * huge;
        }
        if x < u_threshold {
            return twom1000 * twom1000;
        }
    }

    if hx > 0x3FD6_2E42 {
        if hx < 0x3FF0_A2B2 {
            if x == 1.0 {
                return e;
            }
            hi = x - ln2hi[xsb];
            lo = ln2lo[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (invln2 * x + half[xsb]) as i32;
            let t = k as f64;
            hi = x - t * ln2hi[0];
            lo = t * ln2lo[0];
        }
        x = hi - lo;
    } else if hx < 0x3E30_0000 {
        if huge + x > one {
            return one + x;
        }
    } else {
        k = 0;
    }

    let t = x * x;
    let twopk = if k >= -1021 {
        from_words(
            (0x3FF0_0000i32).wrapping_add(((k as u32) << 20) as i32) as u32,
            0,
        )
    } else {
        from_words((0x3FF0_0000u32).wrapping_add(((k + 1000) as u32) << 20), 0)
    };
    let c = x - t * (p1 + t * (p2 + t * (p3 + t * (p4 + t * p5))));
    if k == 0 {
        return one - ((x * c) / (c - 2.0) - x);
    }
    let y = one - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * two1023;
        }
        y * twopk
    } else {
        y * twopk * twom1000
    }
}

/// `Math.log`.
pub fn log(x: f64) -> f64 {
    let ln2_hi = 6.93147180369123816490e-01;
    let ln2_lo = 1.90821492927058770002e-10;
    let two54 = 1.80143985094819840000e+16;
    let lg1 = 6.666666666666735130e-01;
    let lg2 = 3.999999999940941908e-01;
    let lg3 = 2.857142874366239149e-01;
    let lg4 = 2.222219843214978396e-01;
    let lg5 = 1.818357216161805012e-01;
    let lg6 = 1.531383769920937332e-01;
    let lg7 = 1.479819860511658591e-01;
    let zero = 0.0f64;

    let mut x = x;
    let (hx, lx) = words(x);
    let mut hx = hx as i32;
    let mut k = 0i32;
    if hx < 0x0010_0000 {
        if ((hx & 0x7FFF_FFFF) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= two54;
        hx = high_word(x) as i32;
    }
    if hx >= 0x7FF0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000F_FFFF;
    let i = (hx + 0x95F64) & 0x10_0000;
    x = with_high_word(x, (hx | (i ^ 0x3FF0_0000)) as u32);
    k += i >> 20;
    let f = x - 1.0;
    if (0x000F_FFFF & (2 + hx)) < 3 {
        if f == zero {
            if k == 0 {
                return zero;
            }
            let dk = k as f64;
            return dk * ln2_hi + dk * ln2_lo;
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r;
        }
        let dk = k as f64;
        return dk * ln2_hi - ((r - dk * ln2_lo) - f);
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    let i = hx - 0x6147A;
    let w = z * z;
    let j = 0x6B851 - hx;
    let t1 = w * (lg2 + w * (lg4 + w * lg6));
    let t2 = z * (lg1 + w * (lg3 + w * (lg5 + w * lg7)));
    let i = i | j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * ln2_hi - ((hfsq - (s * (hfsq + r) + dk * ln2_lo)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * ln2_hi - ((s * (f - r) - dk * ln2_lo) - f)
    }
}

/// `Math.expm1`.
pub fn expm1(x: f64) -> f64 {
    let one = 1.0f64;
    let tiny = 1.0e-300f64;
    let o_threshold = 7.09782712893383973096e+02;
    let ln2_hi = 6.93147180369123816490e-01;
    let ln2_lo = 1.90821492927058770002e-10;
    let invln2 = 1.44269504088896338700e+00;
    let q1 = -3.33333333333331316428e-02;
    let q2 = 1.58730158725481460165e-03;
    let q3 = -7.93650757867487942473e-05;
    let q4 = 4.00821782732936239552e-06;
    let q5 = -2.01099218183624371326e-07;
    let huge = 1.0e+300f64;

    let mut x = x;
    let hx = high_word(x);
    let xsb = hx & 0x8000_0000;
    let hx = hx & 0x7FFF_FFFF;

    if hx >= 0x4043_687A {
        if hx >= 0x4086_2E42 {
            if hx >= 0x7FF0_0000 {
                let low = low_word(x);
                if ((hx & 0xF_FFFF) | low) != 0 {
                    return x + x;
                } else {
                    return if xsb == 0 { x } else { -1.0 };
                }
            }
            if x > o_threshold {
                return huge * huge;
            }
        }
        if xsb != 0 && x + tiny < 0.0 {
            return tiny - one;
        }
    }

    let hi: f64;
    let lo: f64;
    let k: i32;
    let mut c = 0.0f64;
    if hx > 0x3FD6_2E42 {
        if hx < 0x3FF0_A2B2 {
            if xsb == 0 {
                hi = x - ln2_hi;
                lo = ln2_lo;
                k = 1;
            } else {
                hi = x + ln2_hi;
                lo = -ln2_lo;
                k = -1;
            }
        } else {
            k = (invln2 * x + if xsb == 0 { 0.5 } else { -0.5 }) as i32;
            let t = k as f64;
            hi = x - t * ln2_hi;
            lo = t * ln2_lo;
        }
        x = hi - lo;
        c = (hi - x) - lo;
    } else if hx < 0x3C90_0000 {
        let t = huge + x;
        return x - (t - (huge + x));
    } else {
        k = 0;
    }

    let hfx = 0.5 * x;
    let hxs = x * hfx;
    let r1 = one + hxs * (q1 + hxs * (q2 + hxs * (q3 + hxs * (q4 + hxs * q5))));
    let t = 3.0 - r1 * hfx;
    let mut e = hxs * ((r1 - t) / (6.0 - x * t));
    if k == 0 {
        return x - (x * e - hxs);
    }
    let twopk = from_words(
        (0x3FF0_0000i32).wrapping_add(((k as u32) << 20) as i32) as u32,
        0,
    );
    e = x * (e - c) - c;
    e -= hxs;
    if k == -1 {
        return 0.5 * (x - e) - 0.5;
    }
    if k == 1 {
        return if x < -0.25 {
            -2.0 * (e - (x + 0.5))
        } else {
            one + 2.0 * (x - e)
        };
    }
    if k <= -2 || k > 56 {
        let mut y = one - (e - x);
        if k == 1024 {
            y = y * 2.0 * 8.98846567431158e+307;
        } else {
            y *= twopk;
        }
        return y - one;
    }
    if k < 20 {
        let t = with_high_word(one, (0x3FF0_0000 - (0x20_0000 >> k)) as u32);
        let y = t - (e - x);
        y * twopk
    } else {
        let t = with_high_word(one, ((0x3FF - k) << 20) as u32);
        let mut y = x - (e + t);
        y += one;
        y * twopk
    }
}

/// `Math.tanh`.
pub fn tanh(x: f64) -> f64 {
    let tiny = 1.0e-300f64;
    let one = 1.0f64;
    let two = 2.0f64;
    let huge = 1.0e300f64;

    let jx = high_word(x) as i32;
    let ix = jx & 0x7FFF_FFFF;
    if ix >= 0x7FF0_0000 {
        return if jx >= 0 {
            one / x + one
        } else {
            one / x - one
        };
    }
    let z = if ix < 0x4036_0000 {
        if ix < 0x3E30_0000 && huge + x > one {
            return x;
        }
        if ix >= 0x3FF0_0000 {
            let t = expm1(two * x.abs());
            one - two / (t + two)
        } else {
            let t = expm1(-two * x.abs());
            -t / (t + two)
        }
    } else {
        one - tiny
    };
    if jx >= 0 {
        z
    } else {
        -z
    }
}

/// `Math.cbrt`.
pub fn cbrt(x: f64) -> f64 {
    let b1: u32 = 715094163;
    let b2: u32 = 696219795;
    let p0 = 1.87595182427177009643f64;
    let p1 = -1.88497979543377169875f64;
    let p2 = 1.621429720105354466140f64;
    let p3 = -0.758397934778766047437f64;
    let p4 = 0.145996192886612446982f64;

    let (hx, low) = words(x);
    let sign = hx & 0x8000_0000;
    let hx = hx ^ sign;
    if hx >= 0x7FF0_0000 {
        return x + x;
    }
    let mut t: f64;
    if hx < 0x0010_0000 {
        if (hx | low) == 0 {
            return x;
        }
        t = with_high_word(0.0, 0x4350_0000);
        t *= x;
        let high = high_word(t);
        t = from_words(sign | ((high & 0x7FFF_FFFF) / 3 + b2), 0);
    } else {
        t = from_words(sign | (hx / 3 + b1), 0);
    }

    let r = (t * t) * (t / x);
    t *= (p0 + r * (p1 + r * p2)) + ((r * r) * r) * (p3 + r * p4);

    let bits = (t.to_bits() + 0x8000_0000) & 0xFFFF_FFFF_C000_0000;
    t = f64::from_bits(bits);

    let s = t * t;
    let r = x / s;
    let w = t + t;
    let r = (r - t) / (w + r);
    t + t * r
}

/// `Math.pow`.
pub fn pow(x: f64, y: f64) -> f64 {
    let bp = [1.0f64, 1.5f64];
    let dp_h = [0.0f64, 5.84962487220764160156e-01];
    let dp_l = [0.0f64, 1.35003920212974897128e-08];
    let zero = 0.0f64;
    let one = 1.0f64;
    let two = 2.0f64;
    let two53 = 9007199254740992.0f64;
    let huge = 1.0e300f64;
    let tiny = 1.0e-300f64;
    let l1 = 5.99999999999994648725e-01;
    let l2 = 4.28571428578550184252e-01;
    let l3 = 3.33333329818377432918e-01;
    let l4 = 2.72728123808534006489e-01;
    let l5 = 2.30660745775561754067e-01;
    let l6 = 2.06975017800338417784e-01;
    let p1 = 1.66666666666666019037e-01;
    let p2 = -2.77777777770155933842e-03;
    let p3 = 6.61375632143793436117e-05;
    let p4 = -1.65339022054652515390e-06;
    let p5 = 4.13813679705723846039e-08;
    let lg2 = 6.93147180559945286227e-01;
    let lg2_h = 6.93147182464599609375e-01;
    let lg2_l = -1.90465429995776804525e-09;
    let ovt = 8.0085662595372944372e-0017;
    let cp = 9.61796693925975554329e-01;
    let cp_h = 9.61796700954437255859e-01;
    let cp_l = -7.02846165095275826516e-09;
    let ivln2 = 1.44269504088896338700e+00;
    let ivln2_h = 1.44269502162933349609e+00;
    let ivln2_l = 1.92596299112661746887e-08;

    let (hx, lx) = words(x);
    let (hy, ly) = words(y);
    let hx = hx as i32;
    let hy = hy as i32;
    let mut ix = hx & 0x7fff_ffff;
    let iy = hy & 0x7fff_ffff;

    if (iy as u32 | ly) == 0 {
        return one;
    }
    if ix > 0x7ff0_0000
        || (ix == 0x7ff0_0000 && lx != 0)
        || iy > 0x7ff0_0000
        || (iy == 0x7ff0_0000 && ly != 0)
    {
        return x + y;
    }

    let mut yisint = 0i32;
    if hx < 0 {
        if iy >= 0x4340_0000 {
            yisint = 2;
        } else if iy >= 0x3ff0_0000 {
            let k = (iy >> 20) - 0x3ff;
            if k > 20 {
                let j = (ly >> (52 - k)) as i32;
                if (j << (52 - k)) == ly as i32 {
                    yisint = 2 - (j & 1);
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j << (20 - k)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }

    if ly == 0 {
        if iy == 0x7ff0_0000 {
            if ((ix - 0x3ff0_0000) as u32 | lx) == 0 {
                return y - y;
            } else if ix >= 0x3ff0_0000 {
                return if hy >= 0 { y } else { zero };
            } else {
                return if hy < 0 { -y } else { zero };
            }
        }
        if iy == 0x3ff0_0000 {
            return if hy < 0 { one / x } else { x };
        }
        if hy == 0x4000_0000 {
            return x * x;
        }
        if hy == 0x3fe0_0000 && hx >= 0 {
            return x.sqrt();
        }
    }

    let mut ax = x.abs();
    if lx == 0 && (ix == 0x7ff0_0000 || ix == 0 || ix == 0x3ff0_0000) {
        let mut z = ax;
        if hy < 0 {
            z = one / z;
        }
        if hx < 0 {
            if ((ix - 0x3ff0_0000) | yisint) == 0 {
                z = f64::NAN;
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }

    let mut n = (hx >> 31) + 1;
    if (n | yisint) == 0 {
        return f64::NAN;
    }

    let mut s = one;
    if (n | (yisint - 1)) == 0 {
        s = -one;
    }

    let t1: f64;
    let t2: f64;
    if iy > 0x41e0_0000 {
        if iy > 0x43f0_0000 {
            if ix <= 0x3fef_ffff {
                return if hy < 0 { huge * huge } else { tiny * tiny };
            }
            if ix >= 0x3ff0_0000 {
                return if hy > 0 { huge * huge } else { tiny * tiny };
            }
        }
        if ix < 0x3fef_ffff {
            return if hy < 0 {
                s * huge * huge
            } else {
                s * tiny * tiny
            };
        }
        if ix > 0x3ff0_0000 {
            return if hy > 0 {
                s * huge * huge
            } else {
                s * tiny * tiny
            };
        }
        let t = ax - one;
        let w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
        let u = ivln2_h * t;
        let v = t * ivln2_l - w * ivln2;
        t1 = with_low_word(u + v, 0);
        t2 = v - (t1 - u);
    } else {
        n = 0;
        if ix < 0x0010_0000 {
            ax *= two53;
            n -= 53;
            ix = high_word(ax) as i32;
        }
        n += (ix >> 20) - 0x3ff;
        let j = ix & 0x000f_ffff;
        ix = j | 0x3ff0_0000;
        let k: usize;
        if j <= 0x3988E {
            k = 0;
        } else if j < 0xBB67A {
            k = 1;
        } else {
            k = 0;
            n += 1;
            ix -= 0x0010_0000;
        }
        ax = with_high_word(ax, ix as u32);

        let u = ax - bp[k];
        let v = one / (ax + bp[k]);
        let ss = u * v;
        let s_h = with_low_word(ss, 0);
        let t_h = with_high_word(
            zero,
            ((((ix >> 1) | 0x2000_0000) + 0x0008_0000) + ((k as i32) << 18)) as u32,
        );
        let t_l = ax - (t_h - bp[k]);
        let s_l = v * ((u - s_h * t_h) - s_h * t_l);
        let s2 = ss * ss;
        let mut r = s2 * s2 * (l1 + s2 * (l2 + s2 * (l3 + s2 * (l4 + s2 * (l5 + s2 * l6)))));
        r += s_l * (s_h + ss);
        let s2 = s_h * s_h;
        let t_h = with_low_word(3.0 + s2 + r, 0);
        let t_l = r - ((t_h - 3.0) - s2);
        let u = s_h * t_h;
        let v = s_l * t_h + t_l * ss;
        let p_h = with_low_word(u + v, 0);
        let p_l = v - (p_h - u);
        let z_h = cp_h * p_h;
        let z_l = cp_l * p_h + p_l * cp + dp_l[k];
        let t = n as f64;
        t1 = with_low_word(((z_h + z_l) + dp_h[k]) + t, 0);
        t2 = z_l - (((t1 - t) - dp_h[k]) - z_h);
    }

    let y1 = with_low_word(y, 0);
    let p_l = (y - y1) * t1 + y * t2;
    let mut p_h = y1 * t1;
    let z = p_l + p_h;
    let (j, i) = words(z);
    let j = j as i32;
    if j >= 0x4090_0000 {
        if ((j - 0x4090_0000) as u32 | i) != 0 {
            return s * huge * huge;
        } else if p_l + ovt > z - p_h {
            return s * huge * huge;
        }
    } else if (j & 0x7fff_ffff) >= 0x4090_cc00 {
        if (j.wrapping_sub(0xc090_cc00u32 as i32) as u32 | i) != 0 {
            return s * tiny * tiny;
        } else if p_l <= z - p_h {
            return s * tiny * tiny;
        }
    }

    let i = j & 0x7fff_ffff;
    let mut k = (i >> 20) - 0x3ff;
    let mut n = 0i32;
    if i > 0x3fe0_0000 {
        n = j + (0x0010_0000 >> (k + 1));
        k = ((n & 0x7fff_ffff) >> 20) - 0x3ff;
        let t = with_high_word(zero, (n & !(0x000f_ffff >> k)) as u32);
        n = ((n & 0x000f_ffff) | 0x0010_0000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = with_low_word(p_l + p_h, 0);
    let u = t * lg2_h;
    let v = (p_l - (t - p_h)) * lg2 + t * lg2_l;
    let z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = z - t * (p1 + t * (p2 + t * (p3 + t * (p4 + t * p5))));
    let r = (z * t1) / ((t1 - two) - (w + z * w));
    let mut z = one - (r - z);
    let j = (high_word(z) as i32).wrapping_add(((n as u32) << 20) as i32);
    if (j >> 20) <= 0 {
        z = scalbn(z, n);
    } else {
        let tmp = high_word(z) as i32;
        z = with_high_word(z, tmp.wrapping_add(((n as u32) << 20) as i32) as u32);
    }
    s * z
}

/// `Math.hypot(a, b)`: V8 normalises by the largest magnitude and sums the
/// squares with Kahan compensation before one `sqrt`.
pub fn hypot(a: f64, b: f64) -> f64 {
    let abs_a = a.abs();
    let abs_b = b.abs();
    let mut max = 0.0f64;
    if abs_a > max {
        max = abs_a;
    }
    if abs_b > max {
        max = abs_b;
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for v in [abs_a, abs_b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_elementary_results_preserve_bits_at_sensitive_inputs() {
        // Observed from the frozen Node 22/V8 12.4 runtime. Large-angle
        // reduction, quadrants, roots, powers and scaled norms take distinct
        // paths whose last bit can change projection and controller decisions.
        assert_eq!(sin(1e20).to_bits(), 0xbfe4a5e605fd6450);
        assert_eq!(cos(1e20).to_bits(), 0x3fe872720fc60d3d);
        assert_eq!(atan2(0.3, -0.7).to_bits(), 0x4005e4c36ca0118a);
        assert_eq!(cbrt(2.0).to_bits(), 0x3ff428a2f98d728b);
        assert_eq!(pow(0.9, 4.0).to_bits(), 0x3fe4fec56d5cfaae);
        assert_eq!(hypot(1e200, 1e200).to_bits(), 0x697d8f9811335b57);
        assert_eq!(exp(0.7).to_bits(), 0x40001c2a61268987);
        assert_eq!(log(1.5).to_bits(), 0x3fd9f323ecbf984c);
    }

    #[test]
    fn signed_zero_and_non_finite_boundaries_match_ecmascript() {
        assert_eq!(sin(-0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(cbrt(-0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(atan2(-0.0, -0.0), -std::f64::consts::PI);
        assert_eq!(hypot(-0.0, -0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
        assert!(sin(f64::INFINITY).is_nan());
        assert!(pow(-1.0, 0.5).is_nan());
        assert_eq!(sin_cos(1e20), (sin(1e20), cos(1e20)));
    }
}
