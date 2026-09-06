//! Deterministic content hashing for trace headers, replay keys and input
//! identity.
//!
//! `content_hash(x) == sha256(canonical_json(x))`, where canonical JSON is:
//! object keys sorted, no whitespace, absent optionals omitted, non-finite
//! numbers rejected. Two structurally equal inputs always serialise to the
//! same string, so the digest is a stable content id.
//!
//! The digest must match the JavaScript reference byte-for-byte because it is
//! recorded in every existing trace header (`inputHash`, `templateDigest`,
//! `controlDigest`, ambient candidate keys, …). Three JavaScript details are
//! therefore contractual and implemented here explicitly:
//!
//! 1. numbers print with ECMAScript `Number::toString` (`20`, not `20.0`;
//!    `1e+21`, not `1e21`; `-0` prints as `0`);
//! 2. object keys sort by **UTF-16 code unit** order, not byte order;
//! 3. `undefined` members vanish — in Rust that is `Option::None` skipped on
//!    serialisation, which the domain types do.
//!
//! String escaping is the same in both worlds (`"`, `\`, controls < 0x20), so
//! `serde_json`'s string writer is reused unchanged.

use std::cmp::Ordering;
use std::fmt::Write as _;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::CoreError;

/// SHA-256 of a byte array, lowercase hex.
pub fn sha256_bytes(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    let mut out = String::with_capacity(64);
    for b in digest {
        // Infallible: writing to a String.
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// SHA-256 of a UTF-8 string, lowercase hex.
pub fn sha256(text: &str) -> String {
    sha256_bytes(text.as_bytes())
}

/// Compare two strings by UTF-16 code unit sequence — JavaScript's default
/// `<`/`>` string ordering, used by `Object.keys(...).sort()` and by every
/// `byId` canonical ordering in the input contract.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.as_bytes().cmp(b.as_bytes());
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

/// ICU root collation order of the non-letter printable ASCII characters, as
/// `String.prototype.localeCompare` ranks them under Node's default locale:
/// whitespace, then punctuation and symbols, then digits. Letters follow,
/// case-folded (a lowercase letter precedes its uppercase form only as a
/// tie-break).
const LOCALE_PRIMARY: &[u8; 43] = b" _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";

#[inline]
fn locale_primary(byte: u8) -> u32 {
    if byte.is_ascii_alphabetic() {
        // Fold case onto one primary weight; the tertiary pass orders cases.
        return LOCALE_PRIMARY.len() as u32 + u32::from(byte.to_ascii_lowercase() - b'a');
    }
    match LOCALE_PRIMARY.iter().position(|&c| c == byte) {
        Some(i) => i as u32,
        // Non-printable or non-ASCII: keep code-unit order after the alphabet.
        None => 128 + u32::from(byte),
    }
}

/// Compare two byte strings the way `String.prototype.localeCompare` (ICU
/// root collation) orders identifiers built from the ASCII alphabet: a
/// primary pass with punctuation < digits < case-folded letters, then
/// lowercase-before-uppercase at the first case difference. Used wherever
/// the reference breaks ties with `localeCompare` on rsl, gate or actor ids
/// — `":"` sorts *before* the digits here, so `"4:0:1"` precedes `"41:0:1"`,
/// the opposite of [`cmp_utf16`].
pub fn cmp_locale_bytes(
    a: impl IntoIterator<Item = u8>,
    b: impl IntoIterator<Item = u8>,
) -> Ordering {
    let mut a = a.into_iter();
    let mut b = b.into_iter();
    let mut tertiary = Ordering::Equal;
    loop {
        match (a.next(), b.next()) {
            (None, None) => return tertiary,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x == y {
                    continue;
                }
                match locale_primary(x).cmp(&locale_primary(y)) {
                    Ordering::Equal => {
                        if tertiary == Ordering::Equal {
                            // Same letter, different case: lowercase first.
                            tertiary = if x.is_ascii_lowercase() {
                                Ordering::Less
                            } else {
                                Ordering::Greater
                            };
                        }
                    }
                    other => return other,
                }
            }
        }
    }
}

/// [`cmp_locale_bytes`] over two `&str`.
#[inline]
pub fn cmp_locale(a: &str, b: &str) -> Ordering {
    cmp_locale_bytes(a.bytes(), b.bytes())
}

/// ECMAScript `Number::toString(10)` for a finite double.
///
/// Uses Rust's shortest round-trip digit generation (the same digit string
/// JavaScript engines produce) and applies the spec's fixed/exponent layout
/// rules: fixed notation for decimal exponents in `[-6, 21)`, otherwise
/// `d.ddde±x`.
pub fn js_number_to_string(v: f64) -> String {
    if v == 0.0 {
        return "0".to_owned();
    }
    if v.is_nan() {
        return "NaN".to_owned();
    }
    if v.is_infinite() {
        return if v > 0.0 {
            "Infinity".to_owned()
        } else {
            "-Infinity".to_owned()
        };
    }
    let sci = format!("{:e}", v.abs());
    let (mant, exp) = sci
        .split_once('e')
        .expect("LowerExp always emits an exponent");
    let e: i32 = exp.parse().expect("LowerExp exponent is an integer");
    let digits: Vec<u8> = mant.bytes().filter(|b| *b != b'.').collect();
    let k = digits.len() as i32;
    let n = e + 1;
    let mut out = String::with_capacity(digits.len() + 8);
    if v < 0.0 {
        out.push('-');
    }
    let push_digits = |out: &mut String, range: std::ops::Range<usize>| {
        for d in &digits[range] {
            out.push(char::from(*d));
        }
    };
    if k <= n && n <= 21 {
        push_digits(&mut out, 0..digits.len());
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        push_digits(&mut out, 0..n as usize);
        out.push('.');
        push_digits(&mut out, n as usize..digits.len());
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        push_digits(&mut out, 0..digits.len());
    } else {
        out.push(char::from(digits[0]));
        if k > 1 {
            out.push('.');
            push_digits(&mut out, 1..digits.len());
        }
        out.push('e');
        let exp10 = n - 1;
        out.push(if exp10 < 0 { '-' } else { '+' });
        let _ = write!(out, "{}", exp10.abs());
    }
    out
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), CoreError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                let _ = write!(out, "{i}");
            } else if let Some(u) = n.as_u64() {
                let _ = write!(out, "{u}");
            } else {
                let f = n
                    .as_f64()
                    .ok_or_else(|| CoreError::Canonical(format!("unrepresentable number {n}")))?;
                if !f.is_finite() {
                    return Err(CoreError::Canonical(format!("non-finite number {f}")));
                }
                out.push_str(&js_number_to_string(f));
            }
        }
        Value::String(s) => {
            // serde_json's escaping is identical to JSON.stringify for valid
            // Unicode strings; it cannot fail on a String.
            let escaped = serde_json::to_string(s).map_err(CoreError::Json)?;
            out.push_str(&escaped);
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| cmp_utf16(a, b));
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let escaped = serde_json::to_string(key).map_err(CoreError::Json)?;
                out.push_str(&escaped);
                out.push(':');
                write_canonical(item, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Canonical JSON of a decoded value.
pub fn canonical_json(value: &Value) -> Result<String, CoreError> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

/// Canonical JSON of any serialisable value (domain types skip absent
/// optionals, so they canonicalise exactly like the validated document).
pub fn canonical_json_of<T: Serialize + ?Sized>(value: &T) -> Result<String, CoreError> {
    let v = serde_json::to_value(value).map_err(CoreError::Json)?;
    canonical_json(&v)
}

/// Content id for a decoded JSON value.
pub fn content_hash(value: &Value) -> Result<String, CoreError> {
    Ok(sha256(&canonical_json(value)?))
}

/// Content id for any serialisable value — e.g. a validated `SimScenarioInput`.
pub fn content_hash_of<T: Serialize + ?Sized>(value: &T) -> Result<String, CoreError> {
    Ok(sha256(&canonical_json_of(value)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn js_number_formatting() {
        assert_eq!(js_number_to_string(20.0), "20");
        assert_eq!(js_number_to_string(-0.0), "0");
        assert_eq!(js_number_to_string(0.02), "0.02");
        assert_eq!(js_number_to_string(1234.5), "1234.5");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1e20), "100000000000000000000");
        assert_eq!(js_number_to_string(1e-6), "0.000001");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number_to_string(-2.5), "-2.5");
    }

    #[test]
    fn canonical_json_sorts_keys_and_formats_like_javascript() {
        let v = json!({ "b": [1, 2.5, null], "a": { "z": "x\"y\n", "y": true }, "n": 3.0 });
        assert_eq!(
            canonical_json(&v).unwrap(),
            r#"{"a":{"y":true,"z":"x\"y\n"},"b":[1,2.5,null],"n":3}"#
        );
    }

    #[test]
    fn utf16_ordering_differs_from_byte_ordering_above_bmp() {
        // U+FF5E (BMP, UTF-16 0xFF5E) sorts before U+1F600 (surrogates 0xD83D…) in JS.
        assert_eq!(cmp_utf16("\u{1F600}", "\u{FF5E}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{FF5E}"), Ordering::Greater);
    }

    #[test]
    fn locale_ordering_matches_node_locale_compare() {
        // Observed from `[...].sort((a, b) => a.localeCompare(b))` on Node 22.
        let sorted = [
            "4:0:-1#f", "4:0:1", "4:0:1#f", "4:0:1#r", "4:0:12#f", "41:0:1#f", "a", "A", "ab",
            "aB", "AB", "Ac",
        ];
        for pair in sorted.windows(2) {
            assert_eq!(
                cmp_locale(pair[0], pair[1]),
                Ordering::Less,
                "{} < {}",
                pair[0],
                pair[1]
            );
            assert_eq!(
                cmp_locale(pair[1], pair[0]),
                Ordering::Greater,
                "{} > {}",
                pair[1],
                pair[0]
            );
        }
        assert_eq!(cmp_locale("4:0:1", "4:0:1"), Ordering::Equal);
        // Code-unit order disagrees exactly where a road id is a prefix.
        assert_eq!(cmp_utf16("4:0:1", "41:0:1"), Ordering::Greater);
    }
}
