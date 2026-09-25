//! Numbers printed the way the TypeScript authoring code printed them into
//! messages: `${n}` (ECMAScript `Number::toString`) and `n.toFixed(d)`.
//! Messages are part of the CLI contract (an agent's repair loop reads them),
//! so `20` stays `20`, never `20.0`, and `2.5.toFixed(0)` stays `3`.

pub use simforge_core::hash::js_number_to_string as js;

/// ECMAScript `Number.prototype.toFixed` for finite `|x| < 1e21`: the nearest
/// `n / 10^digits`, an exact tie resolved toward the larger `n` (away from
/// zero once the sign is restored). Rust's `{:.N}` breaks exact ties to even,
/// so it is not a drop-in.
pub fn to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return js(value);
    }
    // Enough exact decimals that any non-tie is separated from the tie digit
    // pattern by far more than an ulp at every magnitude below 1e21.
    let exact = format!("{:.*}", digits + 26, value.abs());
    let (int, frac) = exact
        .split_once('.')
        .expect("fixed formatting emits a decimal point");
    let (keep, rest) = frac.split_at(digits);
    let mut out = Vec::with_capacity(int.len() + digits + 1);
    out.extend_from_slice(int.as_bytes());
    out.extend_from_slice(keep.as_bytes());
    if rest.as_bytes()[0] >= b'5' {
        let mut i = out.len();
        loop {
            if i == 0 {
                out.insert(0, b'1');
                break;
            }
            i -= 1;
            if out[i] == b'9' {
                out[i] = b'0';
            } else {
                out[i] += 1;
                break;
            }
        }
    }
    let split = out.len() - digits;
    let mut s = String::with_capacity(out.len() + 2);
    if value < 0.0 {
        s.push('-');
    }
    s.push_str(std::str::from_utf8(&out[..split]).expect("ascii digits"));
    if digits > 0 {
        s.push('.');
        s.push_str(std::str::from_utf8(&out[split..]).expect("ascii digits"));
    }
    s
}

/// `Number(value.toFixed(digits))`.
pub fn fixed_number(value: f64, digits: usize) -> f64 {
    to_fixed(value, digits).parse().unwrap_or(value)
}

/// `Math.round` (ties toward +infinity).
pub fn round(value: f64) -> f64 {
    simforge_core::math::js_round(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_is_ecmascript() {
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(-1.25, 1), "-1.3");
        assert_eq!(to_fixed(-0.4, 0), "-0");
        assert_eq!(to_fixed(123.456, 0), "123");
        assert_eq!(to_fixed(99.95, 1), "100.0");
        assert_eq!(fixed_number(3.14159, 1), 3.1);
    }

    #[test]
    fn numbers_print_like_template_literals() {
        assert_eq!(js(20.0), "20");
        assert_eq!(js(-0.0), "0");
        assert_eq!(js(0.1 + 0.2), "0.30000000000000004");
    }
}
