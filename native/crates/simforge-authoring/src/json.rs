//! JSON the way the authoring files have always been written.
//!
//! Every file the authoring commands write (`*.instance.json`, `variation.json`,
//! `batch-summary.json`, catalogs, ledgers) is `JSON.stringify(value, null, 2)`
//! plus a newline. Two details make that different from `serde_json`'s pretty
//! printer, and both are kept here so the files stay byte-identical:
//!
//! - numbers print with ECMAScript `Number::toString` (`20`, not `20.0`;
//!   `1e+21`, not `1e21`), non-finite numbers as `null`;
//! - object keys keep the order the value was built in. Typed values
//!   (`#[derive(Serialize)]` structs) are serialised directly, never through a
//!   `serde_json::Value` (which sorts keys).

use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;
use serde_json::ser::{Formatter, PrettyFormatter};
use serde_json::Value;
use simforge_compiler::CompileError;
use simforge_core::hash::js_number_to_string;

/// `serde_json` formatter that prints numbers as JavaScript does.
pub struct JsFormatter<F> {
    inner: F,
}

impl<F: Formatter> JsFormatter<F> {
    pub fn new(inner: F) -> Self {
        Self { inner }
    }
}

fn js_number(v: f64) -> String {
    if v.is_finite() {
        js_number_to_string(v)
    } else {
        "null".to_owned()
    }
}

macro_rules! delegate {
    ($($name:ident($($arg:ident: $ty:ty),*);)*) => {
        $(
            #[inline]
            fn $name<W: ?Sized + Write>(&mut self, writer: &mut W $(, $arg: $ty)*) -> io::Result<()> {
                self.inner.$name(writer $(, $arg)*)
            }
        )*
    };
}

impl<F: Formatter> Formatter for JsFormatter<F> {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(js_number(value).as_bytes())
    }

    fn write_f32<W: ?Sized + Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        writer.write_all(js_number(f64::from(value)).as_bytes())
    }

    delegate! {
        write_null();
        write_bool(value: bool);
        write_i8(value: i8);
        write_i16(value: i16);
        write_i32(value: i32);
        write_i64(value: i64);
        write_i128(value: i128);
        write_u8(value: u8);
        write_u16(value: u16);
        write_u32(value: u32);
        write_u64(value: u64);
        write_u128(value: u128);
        write_number_str(value: &str);
        begin_string();
        end_string();
        write_string_fragment(fragment: &str);
        write_char_escape(char_escape: serde_json::ser::CharEscape);
        write_byte_array(value: &[u8]);
        begin_array();
        end_array();
        begin_array_value(first: bool);
        end_array_value();
        begin_object();
        end_object();
        begin_object_key(first: bool);
        end_object_key();
        begin_object_value();
        end_object_value();
        write_raw_fragment(fragment: &str);
    }
}

/// `JSON.stringify(value, null, 2)`.
pub fn to_pretty_js<T: Serialize + ?Sized>(value: &T) -> Result<String, CompileError> {
    let mut out = Vec::with_capacity(4096);
    let mut ser = serde_json::Serializer::with_formatter(
        &mut out,
        JsFormatter::new(PrettyFormatter::with_indent(b"  ")),
    );
    value
        .serialize(&mut ser)
        .map_err(|e| CompileError::internal(format!("serialise: {e}")))?;
    String::from_utf8(out).map_err(|e| CompileError::internal(e))
}

/// `JSON.stringify(value)` (compact).
pub fn to_compact_js<T: Serialize + ?Sized>(value: &T) -> Result<String, CompileError> {
    let mut out = Vec::with_capacity(1024);
    let mut ser = serde_json::Serializer::with_formatter(
        &mut out,
        JsFormatter::new(serde_json::ser::CompactFormatter),
    );
    value
        .serialize(&mut ser)
        .map_err(|e| CompileError::internal(format!("serialise: {e}")))?;
    String::from_utf8(out).map_err(|e| CompileError::internal(e))
}

/// Write `JSON.stringify(value, null, 2) + "\n"`, creating parent directories.
pub fn write_json_file<T: Serialize + ?Sized>(file: &Path, value: &T) -> Result<(), CompileError> {
    let text = to_pretty_js(value)?;
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
        }
    }
    std::fs::write(file, format!("{text}\n")).map_err(|e| io_error(file, e))
}

pub fn io_error(path: &Path, error: io::Error) -> CompileError {
    CompileError::at("io_error", path.display().to_string(), error.to_string())
}

/// Read a JSON document: `file_not_found` when unreadable, `invalid_json` when
/// it does not parse.
pub fn read_json(file: &Path) -> Result<Value, CompileError> {
    let text = std::fs::read_to_string(file).map_err(|_| {
        CompileError::at(
            "file_not_found",
            file.display().to_string(),
            format!("cannot read {}", file.display()),
        )
    })?;
    serde_json::from_str(&text)
        .map_err(|e| CompileError::at("invalid_json", file.display().to_string(), e.to_string()))
}

/// `Math.round(value * 1000) / 1000`.
pub fn round3(value: f64) -> f64 {
    simforge_compiler::sites::round3(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_javascript() {
        let value = json!({"b": 20.0, "a": [1.5, 1e21, -0.0, 0.1], "c": 3});
        assert_eq!(
            to_compact_js(&value).unwrap(),
            r#"{"a":[1.5,1e+21,0,0.1],"b":20,"c":3}"#
        );
    }

    #[test]
    fn pretty_is_two_space() {
        #[derive(Serialize)]
        struct S {
            z: f64,
            a: Vec<u8>,
        }
        assert_eq!(
            to_pretty_js(&S { z: 2.0, a: vec![] }).unwrap(),
            "{\n  \"z\": 2,\n  \"a\": []\n}"
        );
    }
}
