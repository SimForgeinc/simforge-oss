//! JavaScript number semantics for the render lowering, so the Rust port
//! produces the same bytes the TypeScript native engine produced: the
//! `Number(v.toFixed(6))` quantisation, `Math.round`, and the ECMAScript
//! `Number::toString` digits inside a canonical (sorted-key) JSON encoding
//! (`canonicalSceneJson` in packages/render/src/native/lowering.ts).

use serde_json::Value;

/// ECMAScript `Math.round`: the nearest integer, ties toward +infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    // `x - floor` is exact for every finite double.
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `Number(x.toFixed(digits))` for `digits <= 20` and `|x| < 1e21`.
///
/// `toFixed` picks the decimal nearest to the exact binary value and, on an
/// exact tie, the larger magnitude. Rust's fixed-precision formatting is
/// correctly rounded as well, so they can only differ on exact ties, which
/// happen only when the value has at most `digits + 1` decimal digits; those
/// are formatted exactly and rounded half away from zero here.
pub fn to_fixed(x: f64, digits: usize) -> f64 {
    if !x.is_finite() || x.abs() >= 1e21 {
        return x;
    }
    let exact = format!("{:.*}", digits + 1, x.abs());
    let is_tie = exact.ends_with('5') && {
        // The exact decimal expansion stops at digit `digits + 1` iff
        // formatting with more digits only appends zeros.
        let longer = format!("{:.*}", digits + 30, x.abs());
        longer[exact.len()..].bytes().all(|b| b == b'0')
    };
    let rounded: f64 = if is_tie {
        // Drop the trailing 5 and round the magnitude up by one unit.
        let truncated = &exact[..exact.len() - 1];
        let mut digits_vec: Vec<u8> = truncated.bytes().collect();
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, b'1');
                break;
            }
            i -= 1;
            match digits_vec[i] {
                b'.' => continue,
                b'9' => digits_vec[i] = b'0',
                d => {
                    digits_vec[i] = d + 1;
                    break;
                }
            }
        }
        String::from_utf8(digits_vec)
            .expect("ascii digits")
            .parse()
            .expect("decimal")
    } else {
        format!("{:.*}", digits, x.abs()).parse().expect("decimal")
    };
    if x.is_sign_negative() {
        -rounded
    } else {
        rounded
    }
}

/// `Number(v.toFixed(6))`: the lowering's `q()`.
pub fn q(x: f64) -> f64 {
    to_fixed(x, 6)
}

/// ECMAScript `Number.prototype.toString()` (radix 10) of a finite number;
/// `-0` prints as `0`.
pub fn js_number(x: f64) -> String {
    assert!(x.is_finite(), "js_number of a non-finite value");
    if x == 0.0 {
        return "0".into();
    }
    // Rust's `{:e}` prints the shortest round-trip digits: `d.ddde±x`.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exponent) = sci.split_once('e').expect("exponent form");
    let exponent: i32 = exponent.parse().expect("exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e >= 0 { "+" } else { "-" };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    if x < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

fn number(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return js_number(i as f64);
    }
    if let Some(u) = n.as_u64() {
        return js_number(u as f64);
    }
    js_number(n.as_f64().expect("a JSON number is an f64"))
}

/// `canonicalSceneJson`: sorted keys, no whitespace, JavaScript numbers.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n)),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("string")),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // JavaScript sorts keys by UTF-16 code units; every key here is ASCII.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("key"));
                out.push(':');
                write(&map[*key], out);
            }
            out.push('}');
        }
    }
}

/// A finite f64 as a JSON value (NaN/infinity are a programming error here).
/// A JavaScript number as a JSON value. Integral values within 2^53 become
/// JSON integers, as `JSON.stringify` writes them: the renderer reads several
/// wire fields as integers (`rung`, `utc_day_of_year`, ...), and serde_json
/// would otherwise write an f64 `172` as `172.0`, which an integer field
/// refuses. Canonical encodings are unaffected (they format numbers the
/// JavaScript way either way).
pub fn num(x: f64) -> Value {
    let x = if x == 0.0 { 0.0 } else { x };
    if x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0 {
        return Value::Number(serde_json::Number::from(x as i64));
    }
    Value::Number(serde_json::Number::from_f64(x).expect("finite number"))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_number_strings() {
        for (x, s) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (12.0, "12"),
            (-3.5, "-3.5"),
            (0.1, "0.1"),
            (1e-6, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000123, "0.000123"),
            (2.5e-10, "2.5e-10"),
            (1e100, "1e+100"),
            (41.666667, "41.666667"),
        ] {
            assert_eq!(js_number(x), s, "{x}");
        }
    }

    #[test]
    fn to_fixed_matches_javascript_including_exact_ties() {
        // Values checked against node: Number(x.toFixed(6)).
        assert_eq!(q(0.0078125), 0.007813); // exact tie: 1/128
        assert_eq!(q(-0.0078125), -0.007813);
        assert_eq!(q(1.0000004999), 1.0);
        assert_eq!(q(2.00000051), 2.000001);
        assert_eq!(q(1.0 / 3.0), 0.333333);
        assert_eq!(q(0.9999996), 1.0);
        assert_eq!(to_fixed(0.5, 0), 1.0);
        assert_eq!(to_fixed(2.5, 0), 3.0);
        assert_eq!(to_fixed(-2.5, 0), -3.0);
        assert_eq!(q(-0.0000001).to_bits(), (-0.0f64).to_bits());
    }

    #[test]
    fn js_round_ties_toward_positive_infinity() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(41666.5), 41667.0);
    }

    #[test]
    fn canonical_json_sorts_keys_and_prints_javascript_numbers() {
        let v = serde_json::json!({"b": [1.0, 0.5, 2], "a": {"z": null, "y": true, "x": "s"}});
        assert_eq!(
            canonical_json(&v),
            r#"{"a":{"x":"s","y":true,"z":null},"b":[1,0.5,2]}"#
        );
    }
}
