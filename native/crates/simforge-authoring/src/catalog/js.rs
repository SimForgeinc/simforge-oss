//! JSON values the way JavaScript holds them, for the catalog's digests.
//!
//! Catalog digests are `sha256(JSON.stringify(value))` over objects whose key
//! order is whatever built them: TypeScript object literals when a catalog is
//! created, `JSON.parse` of the file when it is verified. `serde_json::Value`
//! sorts keys and keeps integers apart from doubles, so the catalog works on
//! this value instead:
//!
//! - objects keep insertion order, except that array-index keys (`"0"`,
//!   `"12"`) come first in ascending order, as in every JavaScript object; a
//!   repeated key keeps its first position and its last value;
//! - every number is a double, parsed with a correctly rounded parser (as
//!   `JSON.parse` does) and printed with ECMAScript `Number::toString`
//!   (non-finite numbers print as `null`).

use std::fmt::Write as _;

use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Js>),
    Object(Vec<(String, Js)>),
}

/// An object literal: keys in the given order.
pub fn object<const N: usize>(entries: [(&str, Js); N]) -> Js {
    Js::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

impl Js {
    /// `JSON.parse`.
    pub fn parse(text: &str) -> Result<Js, String> {
        let mut parser = Parser { bytes: text.as_bytes(), at: 0 };
        let value = parser.value(0)?;
        parser.ws();
        if parser.at != parser.bytes.len() {
            return Err(parser.error("Unexpected non-whitespace character after JSON"));
        }
        Ok(value)
    }

    pub fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Js::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `value[key]` on a record, else `undefined` (`None`).
    pub fn field(&self, key: &str) -> Option<&Js> {
        self.get(key)
    }

    /// `object[key] = value` (JavaScript property order).
    pub fn set(&mut self, key: &str, value: Js) {
        if let Js::Object(entries) = self {
            insert(entries, key.to_owned(), value);
        }
    }

    /// `delete object[key]`.
    pub fn remove(&mut self, key: &str) {
        if let Js::Object(entries) = self {
            entries.retain(|(k, _)| k != key);
        }
    }

    /// A copy without `keys` (object rest `{a, b, ...rest}`).
    pub fn without(&self, keys: &[&str]) -> Js {
        match self {
            Js::Object(entries) => Js::Object(
                entries
                    .iter()
                    .filter(|(k, _)| !keys.contains(&k.as_str()))
                    .cloned()
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Js::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Js>> {
        match self {
            Js::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Vec<(String, Js)>> {
        match self {
            Js::Object(o) => Some(o),
            _ => None,
        }
    }

    /// `typeof v === 'object' && v !== null && !Array.isArray(v)`.
    pub fn is_record(&self) -> bool {
        matches!(self, Js::Object(_))
    }

    /// `JSON.stringify(value)`.
    pub fn stringify(&self) -> String {
        let mut out = String::with_capacity(256);
        self.write(&mut out, None, 0);
        out
    }

    /// `JSON.stringify(value, null, 2)`.
    pub fn stringify_pretty(&self) -> String {
        let mut out = String::with_capacity(4096);
        self.write(&mut out, Some(2), 0);
        out
    }

    fn write(&self, out: &mut String, indent: Option<usize>, depth: usize) {
        let newline = |out: &mut String, depth: usize| {
            if let Some(n) = indent {
                out.push('\n');
                out.extend(std::iter::repeat_n(' ', n * depth));
            }
        };
        match self {
            Js::Null => out.push_str("null"),
            Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Js::Number(n) => {
                if n.is_finite() {
                    out.push_str(&number_to_string(*n));
                } else {
                    out.push_str("null");
                }
            }
            Js::String(s) => write_string(s, out),
            Js::Array(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, depth + 1);
                    item.write(out, indent, depth + 1);
                }
                newline(out, depth);
                out.push(']');
            }
            Js::Object(entries) => {
                if entries.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, depth + 1);
                    write_string(key, out);
                    out.push(':');
                    if indent.is_some() {
                        out.push(' ');
                    }
                    value.write(out, indent, depth + 1);
                }
                newline(out, depth);
                out.push('}');
            }
        }
    }

    /// The same value as a `serde_json::Value` (for result documents, whose
    /// key order does not matter).
    pub fn to_value(&self) -> Value {
        match self {
            Js::Null => Value::Null,
            Js::Bool(b) => Value::Bool(*b),
            Js::Number(n) => number_value(*n),
            Js::String(s) => Value::String(s.clone()),
            Js::Array(items) => Value::Array(items.iter().map(Js::to_value).collect()),
            Js::Object(entries) => Value::Object(
                entries.iter().map(|(k, v)| (k.clone(), v.to_value())).collect(),
            ),
        }
    }

    /// A `serde_json::Value` as JavaScript would hold it (objects in the
    /// value's own order).
    pub fn from_value(value: &Value) -> Js {
        match value {
            Value::Null => Js::Null,
            Value::Bool(b) => Js::Bool(*b),
            Value::Number(n) => Js::Number(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => Js::String(s.clone()),
            Value::Array(items) => Js::Array(items.iter().map(Js::from_value).collect()),
            Value::Object(map) => {
                let mut entries = Vec::with_capacity(map.len());
                for (k, v) in map {
                    insert(&mut entries, k.clone(), Js::from_value(v));
                }
                Js::Object(entries)
            }
        }
    }
}

/// A double as a JSON number; integral values print without a fraction.
pub fn number_value(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

impl Serialize for Js {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Js::Null => serializer.serialize_unit(),
            Js::Bool(b) => serializer.serialize_bool(*b),
            Js::Number(n) => {
                if n.is_finite() {
                    serializer.serialize_f64(*n)
                } else {
                    serializer.serialize_unit()
                }
            }
            Js::String(s) => serializer.serialize_str(s),
            Js::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Js::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (k, v) in entries {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl From<&str> for Js {
    fn from(s: &str) -> Self {
        Js::String(s.to_owned())
    }
}
impl From<String> for Js {
    fn from(s: String) -> Self {
        Js::String(s)
    }
}
impl From<&String> for Js {
    fn from(s: &String) -> Self {
        Js::String(s.clone())
    }
}
impl From<f64> for Js {
    fn from(n: f64) -> Self {
        Js::Number(n)
    }
}
impl From<usize> for Js {
    fn from(n: usize) -> Self {
        Js::Number(n as f64)
    }
}
impl From<u32> for Js {
    fn from(n: u32) -> Self {
        Js::Number(f64::from(n))
    }
}
impl From<i64> for Js {
    fn from(n: i64) -> Self {
        Js::Number(n as f64)
    }
}
impl From<bool> for Js {
    fn from(b: bool) -> Self {
        Js::Bool(b)
    }
}
impl From<Vec<Js>> for Js {
    fn from(items: Vec<Js>) -> Self {
        Js::Array(items)
    }
}
impl From<&Js> for Js {
    fn from(v: &Js) -> Self {
        v.clone()
    }
}
impl From<Option<Js>> for Js {
    fn from(v: Option<Js>) -> Self {
        v.unwrap_or(Js::Null)
    }
}

/// An array of strings.
pub fn strings<S: AsRef<str>>(items: &[S]) -> Js {
    Js::Array(items.iter().map(|s| Js::String(s.as_ref().to_owned())).collect())
}

/// ECMAScript `CanonicalNumericIndexString` for array indices: `"0"`, `"17"`
/// (no sign, no leading zero), below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let v: u64 = key.parse().ok()?;
    (v < u64::from(u32::MAX)).then_some(v as u32)
}

/// JavaScript property insertion: replace in place, else integer keys in
/// ascending order before every string key, string keys in insertion order.
fn insert(entries: &mut Vec<(String, Js)>, key: String, value: Js) {
    if let Some(slot) = entries.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = value;
        return;
    }
    match array_index(&key) {
        None => entries.push((key, value)),
        Some(index) => {
            let at = entries
                .iter()
                .position(|(k, _)| array_index(k).is_none_or(|other| other > index))
                .unwrap_or(entries.len());
            entries.insert(at, (key, value));
        }
    }
}

/// `String(value)` for the JSON values a catalog can hold.
pub fn to_js_string(value: Option<&Js>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Js::Null) => "null".to_owned(),
        Some(Js::Bool(b)) => b.to_string(),
        Some(Js::Number(n)) => number_to_string(*n),
        Some(Js::String(s)) => s.clone(),
        Some(Js::Array(items)) => items
            .iter()
            .map(|item| match item {
                Js::Null => String::new(),
                other => to_js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Js::Object(_)) => "[object Object]".to_owned(),
    }
}

/// `a === b` for values read from one document: primitives by value; two
/// distinct objects or arrays are never identical.
pub fn strict_eq(a: Option<&Js>, b: Option<&Js>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Js::Null), Some(Js::Null)) => true,
        (Some(Js::Bool(x)), Some(Js::Bool(y))) => x == y,
        (Some(Js::Number(x)), Some(Js::Number(y))) => x == y,
        (Some(Js::String(x)), Some(Js::String(y))) => x == y,
        (Some(x @ (Js::Array(_) | Js::Object(_))), Some(y)) => std::ptr::eq(x, y),
        _ => false,
    }
}

/// `a === "literal"`.
pub fn is_str(value: Option<&Js>, literal: &str) -> bool {
    matches!(value, Some(Js::String(s)) if s == literal)
}

/// JavaScript truthiness.
pub fn truthy(value: Option<&Js>) -> bool {
    match value {
        None | Some(Js::Null) => false,
        Some(Js::Bool(b)) => *b,
        Some(Js::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(Js::String(s)) => !s.is_empty(),
        Some(Js::Array(_) | Js::Object(_)) => true,
    }
}

/// `Number.isInteger(value)`.
pub fn is_integer(value: Option<&Js>) -> Option<f64> {
    match value {
        Some(Js::Number(n)) if n.is_finite() && n.fract() == 0.0 => Some(*n),
        _ => None,
    }
}

/// ECMAScript `Number::toString(10)`.
///
/// The shortest digit count comes from Rust's shortest round-trip formatter;
/// the digits are then re-derived by correctly rounding the exact value to
/// that many digits, ties to even, which is the ECMAScript rule. Rust's
/// shortest formatter alone breaks such ties upward
/// (`-0.69904327392578125` prints `...813` there and `...812` in JavaScript).
pub fn number_to_string(v: f64) -> String {
    if v == 0.0 {
        return "0".to_owned();
    }
    if v.is_nan() {
        return "NaN".to_owned();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let shortest = format!("{:e}", v.abs());
    let significant = shortest
        .split('e')
        .next()
        .unwrap_or("")
        .bytes()
        .filter(u8::is_ascii_digit)
        .count();
    let sci = format!("{:.*e}", significant.saturating_sub(1), v.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let e: i32 = exp.parse().unwrap_or(0);
    let digits: Vec<u8> = mant.bytes().filter(|b| *b != b'.').collect();
    let end = digits.iter().rposition(|d| *d != b'0').map_or(1, |i| i + 1);
    let digits = &digits[..end];
    let k = digits.len() as i32;
    let n = e + 1;
    let mut out = String::with_capacity(digits.len() + 8);
    if v < 0.0 {
        out.push('-');
    }
    let push = |out: &mut String, range: std::ops::Range<usize>| {
        out.extend(digits[range].iter().map(|d| char::from(*d)));
    };
    if k <= n && n <= 21 {
        push(&mut out, 0..digits.len());
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        push(&mut out, 0..n as usize);
        out.push('.');
        push(&mut out, n as usize..digits.len());
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        push(&mut out, 0..digits.len());
    } else {
        out.push(char::from(digits[0]));
        if k > 1 {
            out.push('.');
            push(&mut out, 1..digits.len());
        }
        let exp10 = n - 1;
        let _ = write!(out, "e{}{}", if exp10 < 0 { '-' } else { '+' }, exp10.abs());
    }
    out
}

/// `JSON.stringify` of a string (ECMAScript `QuoteJSONString`).
fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A strict RFC 8259 parser producing [`Js`].
struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn error(&self, message: &str) -> String {
        format!("{message} in JSON at position {}", self.at)
    }

    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.bytes.get(self.at) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str, value: Js) -> Result<Js, String> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.error("Unexpected token"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Js, String> {
        if depth > 1024 {
            return Err(self.error("Nesting too deep"));
        }
        self.ws();
        match self.bytes.get(self.at) {
            None => Err(self.error("Unexpected end of JSON input")),
            Some(b'{') => {
                self.at += 1;
                let mut entries = Vec::new();
                self.ws();
                if self.bytes.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Js::Object(entries));
                }
                loop {
                    self.ws();
                    if self.bytes.get(self.at) != Some(&b'"') {
                        return Err(self.error("Expected double-quoted property name"));
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.bytes.get(self.at) != Some(&b':') {
                        return Err(self.error("Expected ':' after property name"));
                    }
                    self.at += 1;
                    let value = self.value(depth + 1)?;
                    insert(&mut entries, key, value);
                    self.ws();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Js::Object(entries));
                        }
                        _ => return Err(self.error("Expected ',' or '}' after property value")),
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.ws();
                if self.bytes.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Js::Array(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Js::Array(items));
                        }
                        _ => return Err(self.error("Expected ',' or ']' after array element")),
                    }
                }
            }
            Some(b'"') => Ok(Js::String(self.string()?)),
            Some(b't') => self.literal("true", Js::Bool(true)),
            Some(b'f') => self.literal("false", Js::Bool(false)),
            Some(b'n') => self.literal("null", Js::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.error("Unexpected token")),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<Js, String> {
        let start = self.at;
        if self.bytes[self.at] == b'-' {
            self.at += 1;
        }
        match self.bytes.get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.error("No number after minus sign")),
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(self.error("Unterminated fractional number"));
            }
        }
        if let Some(b'e' | b'E') = self.bytes.get(self.at) {
            self.at += 1;
            if let Some(b'+' | b'-') = self.bytes.get(self.at) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(self.error("Exponent part is missing a number"));
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at]).unwrap_or("0");
        Ok(Js::Number(text.parse().unwrap_or(f64::NAN)))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let hex = self
            .bytes
            .get(self.at..self.at + 4)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u32::from_str_radix(h, 16).ok())
            .ok_or_else(|| self.error("Bad Unicode escape"))?;
        self.at += 4;
        Ok(hex)
    }

    fn string(&mut self) -> Result<String, String> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let run = self.at;
            while let Some(&b) = self.bytes.get(self.at) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            out.push_str(
                std::str::from_utf8(&self.bytes[run..self.at])
                    .map_err(|_| self.error("Invalid UTF-8"))?,
            );
            match self.bytes.get(self.at) {
                None => return Err(self.error("Unterminated string")),
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escape = *self
                        .bytes
                        .get(self.at)
                        .ok_or_else(|| self.error("Unterminated string"))?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            let code = if (0xd800..0xdc00).contains(&first)
                                && self.bytes[self.at..].starts_with(b"\\u")
                            {
                                let save = self.at;
                                self.at += 2;
                                let second = self.hex4()?;
                                if (0xdc00..0xe000).contains(&second) {
                                    0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                                } else {
                                    self.at = save;
                                    first
                                }
                            } else {
                                first
                            };
                            // A lone surrogate has no Rust `char`.
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        _ => return Err(self.error("Bad escaped character")),
                    }
                }
                Some(_) => return Err(self.error("Bad control character in string literal")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_like_javascript() {
        // Expected strings are `JSON.stringify(JSON.parse(input))` in Node 22.
        let cases = [
            (
                r#"{"b":1.0,"a":[1e21,1e-7,0.1,-0.0,123456789012345678901234]}"#,
                r#"{"b":1,"a":[1e+21,1e-7,0.1,0,1.2345678901234569e+23]}"#,
            ),
            (r#"{"k":1,"j":2,"k":3}"#, r#"{"k":3,"j":2}"#),
            (r#"{"b":1,"10":2,"a":3,"2":4,"01":5}"#, r#"{"2":4,"10":2,"b":1,"a":3,"01":5}"#),
            (r#"[-0.69904327392578125, 5e-324, 1.7976931348623157e308]"#, r#"[-0.6990432739257812,5e-324,1.7976931348623157e+308]"#),
        ];
        for (input, expected) in cases {
            assert_eq!(Js::parse(input).unwrap().stringify(), expected, "{input}");
        }
    }

    #[test]
    fn pretty_matches_two_space_stringify() {
        let v = Js::parse(r#"{"a":[],"b":{},"c":[1,{"d":null}]}"#).unwrap();
        assert_eq!(
            v.stringify_pretty(),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": null\n    }\n  ]\n}"
        );
    }

    #[test]
    fn js_string_conversion() {
        assert_eq!(to_js_string(Some(&Js::parse("[1,null,\"x\"]").unwrap())), "1,,x");
        assert_eq!(to_js_string(Some(&Js::Number(1e21))), "1e+21");
        assert_eq!(to_js_string(None), "undefined");
    }
}
