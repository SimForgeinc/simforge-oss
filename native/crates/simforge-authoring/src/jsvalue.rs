//! A JSON document the way JavaScript holds it after `JSON.parse`.
//!
//! Some authoring files are read back and written out again unchanged (a
//! resumed batch cell's `result.json`), and some checks compare documents with
//! `JSON.stringify` (the evidence check's catalog closure). Both depend on the
//! property order JavaScript keeps, which `serde_json::Value` (sorted keys)
//! loses. [`JsValue`] keeps it:
//!
//! - object properties keep insertion order, except that array-index keys
//!   (`"0"`, `"17"`) come first in ascending numeric order, as ECMAScript
//!   orders them;
//! - a repeated key keeps its first position and its last value;
//! - every number is an `f64`.
//!
//! Serialising a `JsValue` through [`crate::json::to_pretty_js`] or
//! [`crate::json::to_compact_js`] is `JSON.stringify` of the parsed value.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::Value;
use simforge_compiler::CompileError;

#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsValue>),
    Object(Vec<(String, JsValue)>),
}

/// ECMAScript array index: a canonical decimal integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    (n < u64::from(u32::MAX)).then_some(n as u32)
}

impl JsValue {
    /// Build an object with JavaScript's property order from entries in
    /// source order.
    pub fn object(entries: Vec<(String, JsValue)>) -> JsValue {
        let mut out: Vec<(String, JsValue)> = Vec::with_capacity(entries.len());
        for (key, value) in entries {
            if let Some(slot) = out.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = value;
            } else {
                out.push((key, value));
            }
        }
        // Stable: string keys keep insertion order behind the index keys.
        out.sort_by_key(|(k, _)| match array_index(k) {
            Some(i) => (0u8, i),
            None => (1u8, 0),
        });
        JsValue::Object(out)
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `value?.a?.b?.c`.
    pub fn at(&self, path: &[&str]) -> Option<&JsValue> {
        let mut cur = self;
        for key in path {
            cur = cur.get(key)?;
        }
        Some(cur)
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

    pub fn as_array(&self) -> Option<&[JsValue]> {
        match self {
            JsValue::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn keys(&self) -> Vec<&str> {
        match self {
            JsValue::Object(entries) => entries.iter().map(|(k, _)| k.as_str()).collect(),
            _ => Vec::new(),
        }
    }

    /// JavaScript truthiness of a JSON value.
    pub fn truthy(&self) -> bool {
        match self {
            JsValue::Null => false,
            JsValue::Bool(b) => *b,
            JsValue::Number(n) => *n != 0.0 && !n.is_nan(),
            JsValue::String(s) => !s.is_empty(),
            JsValue::Array(_) | JsValue::Object(_) => true,
        }
    }

    /// Set (or append) a property, JavaScript assignment semantics.
    pub fn set(&mut self, key: &str, value: JsValue) {
        if let JsValue::Object(entries) = self {
            if let Some(slot) = entries.iter_mut().find(|(k, _)| k == key) {
                slot.1 = value;
                return;
            }
            let mut all = std::mem::take(entries);
            all.push((key.to_owned(), value));
            *self = JsValue::object(all);
        }
    }

    /// `JSON.parse(text)`.
    pub fn parse(text: &str) -> Result<JsValue, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// `JSON.parse(JSON.stringify(value))` for a Rust value: serde field
    /// order becomes property order, as it does across the N-API boundary.
    pub fn from_serialize<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, CompileError> {
        let text = serde_json::to_string(value)
            .map_err(|e| CompileError::internal(format!("serialise: {e}")))?;
        JsValue::parse(&text).map_err(|e| CompileError::internal(format!("reparse: {e}")))
    }

    /// The same document as a `serde_json::Value` (for canonical hashing).
    pub fn to_value(&self) -> Value {
        match self {
            JsValue::Null => Value::Null,
            JsValue::Bool(b) => Value::Bool(*b),
            JsValue::Number(n) => number_value(*n),
            JsValue::String(s) => Value::String(s.clone()),
            JsValue::Array(items) => Value::Array(items.iter().map(JsValue::to_value).collect()),
            JsValue::Object(entries) => Value::Object(
                entries.iter().map(|(k, v)| (k.clone(), v.to_value())).collect(),
            ),
        }
    }
}

/// An `f64` as a JSON number, integral values as integers.
pub fn number_value(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        if n == 0.0 {
            return Value::from(0);
        }
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

impl Serialize for JsValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            JsValue::Null => serializer.serialize_unit(),
            JsValue::Bool(b) => serializer.serialize_bool(*b),
            JsValue::Number(n) => serializer.serialize_f64(*n),
            JsValue::String(s) => serializer.serialize_str(s),
            JsValue::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            JsValue::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (k, v) in entries {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

struct JsVisitor;

impl<'de> Visitor<'de> for JsVisitor {
    type Value = JsValue;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<JsValue, E> {
        Ok(JsValue::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<JsValue, E> {
        Ok(JsValue::Number(v as f64))
    }
    fn visit_u64<E>(self, v: u64) -> Result<JsValue, E> {
        Ok(JsValue::Number(v as f64))
    }
    fn visit_f64<E>(self, v: f64) -> Result<JsValue, E> {
        Ok(JsValue::Number(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<JsValue, E> {
        Ok(JsValue::String(v.to_owned()))
    }
    fn visit_string<E>(self, v: String) -> Result<JsValue, E> {
        Ok(JsValue::String(v))
    }
    fn visit_unit<E>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }
    fn visit_none<E>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<JsValue, D::Error> {
        Deserialize::deserialize(d)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<JsValue, A::Error> {
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(item) = seq.next_element()? {
            out.push(item);
        }
        Ok(JsValue::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<JsValue, A::Error> {
        let mut out = Vec::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((k, v)) = map.next_entry::<String, JsValue>()? {
            out.push((k, v));
        }
        Ok(JsValue::object(out))
    }
}

impl<'de> Deserialize<'de> for JsValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<JsValue, D::Error> {
        d.deserialize_any(JsVisitor)
    }
}

/// `sha256(canonicalJson(value))` of a JavaScript value.
pub fn content_hash(value: &JsValue) -> String {
    simforge_core::hash::content_hash(&value.to_value()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::to_compact_js;

    #[test]
    fn keeps_javascript_property_order() {
        let v = JsValue::parse(r#"{"b":1,"a":2,"2":3,"10":4,"01":5,"b":6}"#).unwrap();
        assert_eq!(to_compact_js(&v).unwrap(), r#"{"2":3,"10":4,"b":6,"a":2,"01":5}"#);
    }

    #[test]
    fn numbers_are_doubles() {
        let v = JsValue::parse(r#"[1, 1.0, 1e21, 0.1, -0]"#).unwrap();
        assert_eq!(to_compact_js(&v).unwrap(), "[1,1,1e+21,0.1,0]");
    }
}
