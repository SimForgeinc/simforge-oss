//! Seeded PRNG, bit-identical to the JavaScript reference engine.
//!
//! The engine core is deterministic and does not *need* randomness, but
//! jitter-style behaviours (driver reaction spread, sampled dynamics, ambient
//! candidate pools, parameter draws) draw from here so that every stochastic
//! element is reproducible from the seed.
//!
//! Every detail below is a wire contract, not an implementation choice:
//!
//! - string seeds fold **UTF-16 code units** through FNV-1a (`seed_from_string`);
//! - numeric seeds go through ECMAScript `ToUint32(abs(trunc(seed)))`;
//! - a zero seed is replaced by the golden-ratio constant before SplitMix32
//!   expands it into the four xoshiro128** words;
//! - `fork(label)` keys the child on the **current** `s0` word XOR the label's
//!   string seed, so a fork after `n` draws is a different stream from a fork
//!   after `n + 1`.
//!
//! Changing any of these changes every seeded scenario's behaviour.

use serde::{Deserialize, Serialize};

const GOLDEN: u32 = 0x9e37_79b9;

/// The public `seed` field of a scenario document: `number | string`.
///
/// The number is kept as the parsed double so `ToUint32` semantics (modulo
/// 2³²) hold for every value the JSON contract accepts, including integers
/// beyond `i64`.
#[derive(Debug, Clone, PartialEq)]
pub enum Seed {
    Number(f64),
    Text(String),
}

impl Seed {
    /// Normalise to the 32-bit integer that keys the generator.
    pub fn to_u32(&self) -> u32 {
        normalize_seed(self)
    }
}

impl From<f64> for Seed {
    fn from(v: f64) -> Self {
        Seed::Number(v)
    }
}
impl From<i64> for Seed {
    fn from(v: i64) -> Self {
        Seed::Number(v as f64)
    }
}
impl From<u32> for Seed {
    fn from(v: u32) -> Self {
        Seed::Number(f64::from(v))
    }
}
impl From<&str> for Seed {
    fn from(v: &str) -> Self {
        Seed::Text(v.to_owned())
    }
}
impl From<String> for Seed {
    fn from(v: String) -> Self {
        Seed::Text(v)
    }
}

impl Serialize for Seed {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Seed::Number(n) => {
                // Integral doubles serialise as JSON integers, like JavaScript.
                if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
                    s.serialize_i64(*n as i64)
                } else {
                    s.serialize_f64(*n)
                }
            }
            Seed::Text(t) => s.serialize_str(t),
        }
    }
}

impl<'de> Deserialize<'de> for Seed {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = Seed;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an integer or a string seed")
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Seed, E> {
                Ok(Seed::Number(v as f64))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Seed, E> {
                Ok(Seed::Number(v as f64))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Seed, E> {
                if v.is_finite() && v.fract() == 0.0 {
                    Ok(Seed::Number(v))
                } else {
                    Err(E::custom("seed must be an integer or a string"))
                }
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Seed, E> {
                Ok(Seed::Text(v.to_owned()))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Seed, E> {
                Ok(Seed::Text(v))
            }
        }
        d.deserialize_any(V)
    }
}

/// SplitMix32: expands a single integer seed into well-mixed 32-bit words.
#[inline]
fn splitmix32(state: &mut u32) -> u32 {
    *state = state.wrapping_add(0x9e37_79b9);
    let mut t = *state;
    t = (t ^ (t >> 16)).wrapping_mul(0x21f0_aaad);
    t = (t ^ (t >> 15)).wrapping_mul(0x735a_2d97);
    t ^ (t >> 15)
}

/// FNV-1a over UTF-16 code units — folds string seeds into 32 bits.
pub fn seed_from_string(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for unit in s.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// ECMAScript `ToUint32(x)` for a finite double.
#[inline]
fn to_uint32(x: f64) -> u32 {
    // `%` on f64 is an exact fmod, so the modulo is exact for every double.
    (x.trunc() % 4_294_967_296.0) as u32
}

/// Normalise the public `seed` field (`number | string`) to a 32-bit integer.
pub fn normalize_seed(seed: &Seed) -> u32 {
    match seed {
        Seed::Number(n) => {
            if n.is_finite() {
                to_uint32(n.trunc().abs())
            } else {
                0
            }
        }
        Seed::Text(t) => seed_from_string(t),
    }
}

/// xoshiro128** — small state, good equidistribution, integer-exact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    /// Seed from the public `seed` field.
    pub fn new(seed: &Seed) -> Self {
        Self::from_u32(normalize_seed(seed))
    }

    /// Seed from an already-normalised 32-bit integer. Zero maps to the
    /// golden-ratio constant, exactly as the reference does.
    pub fn from_u32(seed: u32) -> Self {
        let mut state = if seed == 0 { GOLDEN } else { seed };
        let s0 = splitmix32(&mut state);
        let s1 = splitmix32(&mut state);
        let s2 = splitmix32(&mut state);
        let s3 = splitmix32(&mut state);
        Self {
            s: [s0, s1, s2, s3],
        }
    }

    /// Seed from a string label without going through `Seed`.
    pub fn from_label(label: &str) -> Self {
        Self::from_u32(seed_from_string(label))
    }

    /// Next raw 32-bit unsigned integer.
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let [s0, s1, s2, s3] = &mut self.s;
        let result = s1.wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = *s1 << 9;
        *s2 ^= *s0;
        *s3 ^= *s1;
        *s1 ^= *s2;
        *s0 ^= *s3;
        *s2 ^= t;
        *s3 = s3.rotate_left(11);
        result
    }

    /// Uniform in `[0, 1)`, with the reference's 32-bit resolution.
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        f64::from(self.next_u32()) / 4_294_967_296.0
    }

    /// Uniform in `[lo, hi)`.
    #[inline]
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next_f64()
    }

    /// A child stream keyed by a label and by this generator's current `s0`.
    pub fn fork(&self, label: &str) -> Rng {
        Rng::from_u32(self.s[0] ^ seed_from_string(label))
    }

    /// Complete generator state, for snapshot/restore.
    #[inline]
    pub const fn state(&self) -> [u32; 4] {
        self.s
    }

    /// Restore a generator from [`Rng::state`].
    #[inline]
    pub const fn from_state(s: [u32; 4]) -> Self {
        Self { s }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_seed_uses_utf16_units() {
        // "€" is one UTF-16 unit (0x20AC) but three UTF-8 bytes.
        let mut h: u32 = 0x811c_9dc5;
        h ^= 0x20ac;
        h = h.wrapping_mul(0x0100_0193);
        assert_eq!(seed_from_string("€"), h);
        assert_eq!(seed_from_string(""), 0x811c_9dc5);
    }

    #[test]
    fn numeric_seed_normalisation() {
        assert_eq!(normalize_seed(&Seed::Number(-7.0)), 7);
        assert_eq!(normalize_seed(&Seed::Number(4_294_967_296.0 + 5.0)), 5);
        assert_eq!(normalize_seed(&Seed::Number(f64::INFINITY)), 0);
        assert_eq!(Rng::new(&Seed::Number(0.0)), Rng::from_u32(GOLDEN));
    }

    #[test]
    fn deterministic_and_forkable() {
        let mut a = Rng::new(&Seed::from("abc"));
        let mut b = Rng::new(&Seed::from("abc"));
        assert_eq!([a.next_u32(), a.next_u32()], [b.next_u32(), b.next_u32()]);
        let fa = a.fork("x");
        let fb = b.fork("x");
        assert_eq!(fa, fb);
        a.next_u32();
        assert_ne!(a.fork("x"), fb);
        let v = a.next_f64();
        assert!((0.0..1.0).contains(&v));
    }
}
