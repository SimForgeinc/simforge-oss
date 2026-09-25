//! JSON exactly as JavaScript's `JSON.parse` / `JSON.stringify` see it.
//!
//! The TypeScript engine rewrites the map master with
//! `JSON.stringify(JSON.parse(master))` and hashes `JSON.stringify` of small
//! arrays. Byte-identical output needs JavaScript's rules, which
//! `serde_json::Value` does not follow: object keys keep insertion order (a
//! repeated key keeps its first position and its last value), every number
//! is an IEEE double printed by `Number::toString` (`1.0` becomes `1`,
//! `1e21` stays `1e+21`), and non-finite numbers print as `null`.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    /// Insertion-ordered entries, unique keys.
    Object(Vec<(String, JsValue)>),
}

impl JsValue {
    /// `JSON.parse`.
    pub fn parse(text: &str) -> Result<Self, ParseError> {
        let mut parser = Parser {
            bytes: text.as_bytes(),
            at: 0,
        };
        let value = parser.value(0)?;
        parser.ws();
        if parser.at != text.len() {
            return parser.fail("unexpected trailing input");
        }
        Ok(value)
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut JsValue> {
        match self {
            JsValue::Object(entries) => entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `object[key] = value`: replaces in place, else appends.
    pub fn set(&mut self, key: &str, value: JsValue) {
        if let JsValue::Object(entries) = self {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some((_, slot)) => *slot = value,
                None => entries.push((key.to_owned(), value)),
            }
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JsValue::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<JsValue>> {
        match self {
            JsValue::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_array_mut(&mut self) -> Option<&mut Vec<JsValue>> {
        match self {
            JsValue::Array(a) => Some(a),
            _ => None,
        }
    }

    /// `JSON.stringify(value)` (no indentation).
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            JsValue::Null => out.push_str("null"),
            JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            JsValue::Number(n) => {
                if n.is_finite() {
                    out.push_str(&js_number_to_string(*n));
                } else {
                    out.push_str("null");
                }
            }
            JsValue::String(s) => write_string(s, out),
            JsValue::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            JsValue::Object(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

impl From<&str> for JsValue {
    fn from(s: &str) -> Self {
        JsValue::String(s.to_owned())
    }
}

impl From<String> for JsValue {
    fn from(s: String) -> Self {
        JsValue::String(s)
    }
}

/// ECMAScript `Number::toString(10)`: `simforge_core::hash::js_number_to_string`
/// (shortest round-trip digits, exact ties to even) plus the non-finite names.
pub fn js_number_to_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".to_owned();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    simforge_core::hash::js_number_to_string(v)
}

/// `JSON.stringify` of a string (ECMAScript QuoteJSONString).
pub fn write_string(s: &str, out: &mut String) {
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
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A JSON syntax error with its byte offset.
#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub offset: usize,
    pub message: &'static str,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{} at byte {}", self.message, self.offset)
    }
}

impl std::error::Error for ParseError {}

/// A strict RFC 8259 parser. Numbers are parsed from their text with Rust's
/// correctly rounded `f64` parser, which is what `JSON.parse` does: the
/// nearest double to the decimal (serde_json's default fast path is not
/// always correctly rounded, and one ulp changes `Number::toString`).
struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn fail<T>(&self, message: &'static str) -> Result<T, ParseError> {
        Err(ParseError {
            offset: self.at,
            message,
        })
    }

    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.bytes.get(self.at) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &str, value: JsValue) -> Result<JsValue, ParseError> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            self.fail("unexpected token")
        }
    }

    fn value(&mut self, depth: usize) -> Result<JsValue, ParseError> {
        if depth > 512 {
            return self.fail("nesting too deep");
        }
        self.ws();
        match self.bytes.get(self.at) {
            None => self.fail("unexpected end of input"),
            Some(b'{') => {
                self.at += 1;
                let mut object = JsValue::Object(Vec::new());
                self.ws();
                if self.bytes.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(object);
                }
                loop {
                    self.ws();
                    if self.bytes.get(self.at) != Some(&b'"') {
                        return self.fail("expected a string key");
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.bytes.get(self.at) != Some(&b':') {
                        return self.fail("expected ':'");
                    }
                    self.at += 1;
                    let value = self.value(depth + 1)?;
                    object.set(&key, value);
                    self.ws();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(object);
                        }
                        _ => return self.fail("expected ',' or '}'"),
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.ws();
                if self.bytes.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(JsValue::Array(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.bytes.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(JsValue::Array(items));
                        }
                        _ => return self.fail("expected ',' or ']'"),
                    }
                }
            }
            Some(b'"') => Ok(JsValue::String(self.string()?)),
            Some(b't') => self.literal("true", JsValue::Bool(true)),
            Some(b'f') => self.literal("false", JsValue::Bool(false)),
            Some(b'n') => self.literal("null", JsValue::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => self.fail("unexpected token"),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<JsValue, ParseError> {
        let start = self.at;
        if self.bytes[self.at] == b'-' {
            self.at += 1;
        }
        match self.bytes.get(self.at) {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return self.fail("invalid number"),
        }
        if self.bytes.get(self.at) == Some(&b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return self.fail("invalid number");
            }
        }
        if let Some(b'e' | b'E') = self.bytes.get(self.at) {
            self.at += 1;
            if let Some(b'+' | b'-') = self.bytes.get(self.at) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return self.fail("invalid number");
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at]).expect("ASCII digits");
        Ok(JsValue::Number(
            text.parse().expect("a JSON number is a valid f64 literal"),
        ))
    }

    fn hex4(&mut self) -> Result<u32, ParseError> {
        let Some(hex) = self.bytes.get(self.at..self.at + 4) else {
            return self.fail("invalid unicode escape");
        };
        let text = std::str::from_utf8(hex).map_err(|_| ParseError {
            offset: self.at,
            message: "invalid unicode escape",
        })?;
        let v = u32::from_str_radix(text, 16).map_err(|_| ParseError {
            offset: self.at,
            message: "invalid unicode escape",
        })?;
        self.at += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.at += 1; // opening quote
        let mut out = String::new();
        loop {
            let run_start = self.at;
            while let Some(&b) = self.bytes.get(self.at) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            out.push_str(
                std::str::from_utf8(&self.bytes[run_start..self.at]).map_err(|_| ParseError {
                    offset: run_start,
                    message: "invalid UTF-8",
                })?,
            );
            match self.bytes.get(self.at) {
                None => return self.fail("unterminated string"),
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let Some(&escape) = self.bytes.get(self.at) else {
                        return self.fail("unterminated string");
                    };
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
                            // A lone surrogate has no Rust `char`: U+FFFD (maps never carry one).
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        _ => return self.fail("invalid escape"),
                    }
                }
                Some(_) => return self.fail("control character in string"),
            }
        }
    }
}

/// `JSON.stringify` of an array of strings (hash preimages).
pub fn stringify_strings(items: &[&str]) -> String {
    JsValue::Array(items.iter().map(|s| JsValue::from(*s)).collect()).stringify()
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
            (
                "\"\\u0001\\u001f\\b\\f\\n\\r\\t\\\"\\\\/é\u{2028}\"",
                "\"\\u0001\\u001f\\b\\f\\n\\r\\t\\\"\\\\/é\u{2028}\"",
            ),
            (r#"[true,false,null,{},[]]"#, r#"[true,false,null,{},[]]"#),
            (
                r#"[5e-324,1.7976931348623157e308,100,1e6,0.000001]"#,
                r#"[5e-324,1.7976931348623157e+308,100,1000000,0.000001]"#,
            ),
            // Correct rounding (serde_json's default fast path gets this one wrong).
            (r#"[-0.6990432739257813]"#, r#"[-0.6990432739257812]"#),
            ("\"\\ud83d\\ude00\"", "\"\u{1f600}\""),
        ];
        for (input, expected) in cases {
            assert_eq!(
                JsValue::parse(input).unwrap().stringify(),
                expected,
                "{input}"
            );
        }
    }

    #[test]
    fn numbers_print_like_javascript_including_ties() {
        // `String(x)` in Node 22.
        for (x, expected) in [
            // Exactly -0.69904327392578125: a tie between ...812 and ...813.
            (-0.6990432739257812, "-0.6990432739257812"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (5e-324, "5e-324"),
            (-2.5, "-2.5"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(js_number_to_string(x), expected);
        }
    }

    #[test]
    fn set_appends_new_keys_at_the_end() {
        let mut v = JsValue::parse(r#"{"uri":"a"}"#).unwrap();
        v.set("uri", "b".into());
        v.set("mimeType", "image/ktx2".into());
        assert_eq!(v.stringify(), r#"{"uri":"b","mimeType":"image/ktx2"}"#);
    }
}
