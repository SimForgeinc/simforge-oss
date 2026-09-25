//! `simforge.env-serve/v1` framing.
//!
//! Every message, in both directions:
//!
//! ```text
//! u32 LE  total    bytes after this field (= 4 + header + tail)
//! u32 LE  header   bytes of the JSON header
//! [header]         UTF-8 JSON object
//! [tail]           binary payloads
//! ```
//!
//! Arrays and images travel in the tail; the header names each one as
//! `{"offset", "length", "dtype", "shape"}` with a numpy dtype string
//! (`"<f8"`, `"<f4"`, `"|u1"`), so a client needs only a JSON parser and
//! `numpy.frombuffer`. Requests are `{"op", "i"?, ...}`; every response
//! echoes `i` and carries `ok`. A failed request answers
//! `{"ok": false, "code", "reason", "detail"?}`.

use std::io::{self, Read, Write};

use serde_json::{json, Value};

pub const PROTOCOL: &str = "simforge.env-serve/v1";
/// Refuse any message larger than this (a sensor bundle of a few 4K
/// cameras fits many times over).
pub const MAX_MESSAGE_BYTES: u32 = 1 << 30;

pub struct Message {
    pub header: Value,
    pub tail: Vec<u8>,
}

/// Read one message; `Ok(None)` on a clean end of stream.
pub fn read_message(reader: &mut impl Read) -> io::Result<Option<Message>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let total = u32::from_le_bytes(len);
    if !(4..=MAX_MESSAGE_BYTES).contains(&total) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("message length {total} outside 4..={MAX_MESSAGE_BYTES}"),
        ));
    }
    let mut body = vec![0u8; total as usize];
    reader.read_exact(&mut body)?;
    let header_len = u32::from_le_bytes(body[..4].try_into().expect("4 bytes")) as usize;
    if header_len > body.len() - 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("header length {header_len} exceeds the message"),
        ));
    }
    let header: Value = serde_json::from_slice(&body[4..4 + header_len])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("header JSON: {e}")))?;
    let tail = body[4 + header_len..].to_vec();
    Ok(Some(Message { header, tail }))
}

pub fn write_message(writer: &mut impl Write, header: &Value, tail: &[u8]) -> io::Result<()> {
    let header = serde_json::to_vec(header).expect("JSON values serialize");
    let total = 4 + header.len() + tail.len();
    let total = u32::try_from(total)
        .ok()
        .filter(|t| *t <= MAX_MESSAGE_BYTES)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "message too large"))?;
    writer.write_all(&total.to_le_bytes())?;
    writer.write_all(&(header.len() as u32).to_le_bytes())?;
    writer.write_all(&header)?;
    writer.write_all(tail)?;
    writer.flush()
}

/// A response tail under construction.
#[derive(Default)]
pub struct Tail {
    pub bytes: Vec<u8>,
}

impl Tail {
    fn push(&mut self, data: &[u8], dtype: &str, shape: &[usize]) -> Value {
        // 8-byte alignment so a client may view f64 payloads in place.
        while self.bytes.len() % 8 != 0 {
            self.bytes.push(0);
        }
        let offset = self.bytes.len();
        self.bytes.extend_from_slice(data);
        json!({ "offset": offset, "length": data.len(), "dtype": dtype, "shape": shape })
    }

    pub fn f64s(&mut self, data: &[f64], shape: &[usize]) -> Value {
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.push(&bytes, "<f8", shape)
    }

    pub fn f32s(&mut self, data: &[f32], shape: &[usize]) -> Value {
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.push(&bytes, "<f4", shape)
    }

    pub fn u8s(&mut self, data: &[u8], shape: &[usize]) -> Value {
        self.push(data, "|u1", shape)
    }

    pub fn raw(&mut self, data: &[u8]) -> Value {
        self.push(data, "|u1", &[data.len()])
    }
}

/// Read `ref` (`{offset, length}`) out of a request tail.
pub fn slice<'a>(tail: &'a [u8], reference: &Value) -> Option<&'a [u8]> {
    let offset = reference["offset"].as_u64()? as usize;
    let length = reference["length"].as_u64()? as usize;
    tail.get(offset..offset.checked_add(length)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_tail() {
        let mut tail = Tail::default();
        let a = tail.f64s(&[1.5, -2.0], &[2]);
        let b = tail.u8s(&[1, 2, 3], &[3]);
        let header = json!({ "ok": true, "a": a, "b": b });
        let mut buf = Vec::new();
        write_message(&mut buf, &header, &tail.bytes).unwrap();
        let msg = read_message(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(msg.header, header);
        let bytes = slice(&msg.tail, &msg.header["a"]).unwrap();
        assert_eq!(f64::from_le_bytes(bytes[8..16].try_into().unwrap()), -2.0);
        assert_eq!(slice(&msg.tail, &msg.header["b"]).unwrap(), &[1, 2, 3]);
        assert!(read_message(&mut &b""[..]).unwrap().is_none());
    }
}
