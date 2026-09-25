//! The strict ZIP subset (scenario-package.md sections 3.2 and 10).
//!
//! The writer emits exactly one encoding: fixed DOS time 1980-01-01 00:00,
//! Unix "made by", mode `0100644`, flag bit 11 only, CRC and sizes in the
//! local header (no data descriptors), no extra fields other than ZIP64, no
//! comments, no directories. ZIP64 is used only when [`zip64_required`] says
//! so, and then uniformly on every entry.
//!
//! The reader accepts only that subset. It trusts nothing it has not
//! cross-checked: the end records must sit exactly at the end of the file,
//! the central directory must immediately precede them, local headers must
//! agree with it field by field, entries must tile the file from offset 0
//! with no gap or overlap, and inflation stops at the declared size.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};

use flate2::write::DeflateEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

use crate::error::{ErrorCode, PackageError, Result};
use crate::names::is_allowed_name;

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const LOCATOR_SIG: u32 = 0x0706_4b50;

const FLAG_UTF8: u16 = 0x0800;
const DOS_TIME: u16 = 0;
/// 1980-01-01: ((1980 - 1980) << 9) | (1 << 5) | 1.
const DOS_DATE: u16 = 0x0021;
const UNIX_FILE_MODE: u32 = 0o100_644;
const MADE_BY_UNIX: u16 = 3 << 8;
const VERSION_DEFAULT: u16 = 20;
const VERSION_ZIP64: u16 = 45;
const ZIP64_EXTRA_ID: u16 = 0x0001;
const LOCAL_HEADER_LEN: u64 = 30;
const CENTRAL_HEADER_LEN: usize = 46;
const EOCD_LEN: u64 = 22;
const EOCD64_LEN: u64 = 56;
const LOCATOR_LEN: u64 = 20;
const DEFLATE_LEVEL: u32 = 6;

/// ZIP64 switches on above this many bytes of entry data. The margin under
/// 4 GiB covers every header, the central directory at 65,535 entries and
/// DEFLATE's worst-case expansion, so a container written without ZIP64 can
/// never overflow a 32-bit field.
pub const ZIP64_DATA_THRESHOLD: u64 = 0xFFFF_FFFF - 64 * 1024 * 1024;
pub const ZIP64_ENTRY_THRESHOLD: usize = 65_535;

/// The one ZIP64 rule, shared by writer and reader, so the same content
/// always takes the same branch: more than 65,535 entries, or entry data
/// (uncompressed) totalling at least [`ZIP64_DATA_THRESHOLD`].
pub fn zip64_required(entry_count: usize, total_uncompressed: u64) -> bool {
    entry_count > ZIP64_ENTRY_THRESHOLD || total_uncompressed >= ZIP64_DATA_THRESHOLD
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Store,
    Deflate,
}

impl Method {
    fn code(self) -> u16 {
        match self {
            Method::Store => 0,
            Method::Deflate => 8,
        }
    }
}

/// Reader limits (section 10 defaults). Host-configurable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Container size when the package is thin (no `blobs/`).
    pub max_thin_bytes: u64,
    /// Container size when the package is full.
    pub max_full_bytes: u64,
    pub max_entries: usize,
    pub max_manifest_bytes: u64,
    /// Any single non-blob member (inflated).
    pub max_member_bytes: u64,
    /// Inflated/compressed ratio per DEFLATE entry...
    pub max_deflate_ratio: u64,
    /// ...for entries larger than this (a few KB of repetitive JSON can
    /// legitimately exceed any ratio, and cannot be a bomb).
    pub ratio_floor_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_thin_bytes: 64 * 1024 * 1024,
            max_full_bytes: 32 * 1024 * 1024 * 1024,
            max_entries: 100_000,
            max_manifest_bytes: 1024 * 1024,
            max_member_bytes: 256 * 1024 * 1024,
            max_deflate_ratio: 200,
            ratio_floor_bytes: 1024 * 1024,
        }
    }
}

fn io_err(err: io::Error) -> PackageError {
    PackageError::io(err)
}

fn invalid(rule: &'static str, message: impl Into<String>) -> PackageError {
    PackageError::container(rule, message)
}

/* ------------------------------------------------------------------ writer */

struct CentralRecord {
    name: String,
    method: Method,
    crc: u32,
    compressed: u64,
    size: u64,
    offset: u64,
}

/// Counts bytes on their way to the output.
struct Counting<'a, W: Write> {
    inner: &'a mut W,
    count: u64,
}

impl<W: Write> Write for Counting<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// What the writer computed while streaming an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrittenEntry {
    pub sha256: String,
    pub size: u64,
    pub compressed: u64,
}

/// Deterministic strict-subset ZIP writer. The output must start at offset 0.
pub struct ZipWriter<W: Write + Seek> {
    out: W,
    zip64: bool,
    pos: u64,
    records: Vec<CentralRecord>,
}

impl<W: Write + Seek> ZipWriter<W> {
    pub fn new(mut out: W, zip64: bool) -> Result<Self> {
        let pos = out.stream_position().map_err(io_err)?;
        if pos != 0 {
            return Err(PackageError::argument(
                "output_not_at_start",
                "the container must be written from offset 0",
            ));
        }
        Ok(Self {
            out,
            zip64,
            pos: 0,
            records: Vec::new(),
        })
    }

    fn version(&self) -> u16 {
        if self.zip64 {
            VERSION_ZIP64
        } else {
            VERSION_DEFAULT
        }
    }

    /// Stream one entry of exactly `size` bytes from `data`. Returns the
    /// sha256 of the entry's bytes, so the caller can prove a content address.
    pub fn add(
        &mut self,
        name: &str,
        method: Method,
        size: u64,
        data: &mut dyn Read,
    ) -> Result<WrittenEntry> {
        if !is_allowed_name(name) {
            return Err(PackageError::argument(
                "name_not_allowed",
                format!("{name:?} is not an allowed member name"),
            ));
        }
        if !self.zip64 && size >= ZIP64_DATA_THRESHOLD {
            return Err(PackageError::argument(
                "zip64_required",
                "entry too large for a non-ZIP64 container",
            ));
        }
        let offset = self.pos;
        let version = self.version();
        let mut header = Vec::with_capacity(LOCAL_HEADER_LEN as usize + name.len() + 20);
        put_u32(&mut header, LOCAL_SIG);
        put_u16(&mut header, version);
        put_u16(&mut header, FLAG_UTF8);
        put_u16(&mut header, method.code());
        put_u16(&mut header, DOS_TIME);
        put_u16(&mut header, DOS_DATE);
        put_u32(&mut header, 0); // crc, patched
        if self.zip64 {
            put_u32(&mut header, u32::MAX);
            put_u32(&mut header, u32::MAX);
        } else {
            put_u32(&mut header, 0); // compressed, patched
            put_u32(&mut header, size as u32);
        }
        put_u16(&mut header, name.len() as u16);
        put_u16(&mut header, if self.zip64 { 20 } else { 0 });
        header.extend_from_slice(name.as_bytes());
        if self.zip64 {
            put_u16(&mut header, ZIP64_EXTRA_ID);
            put_u16(&mut header, 16);
            put_u64(&mut header, size);
            put_u64(&mut header, 0); // compressed, patched
        }
        self.out.write_all(&header).map_err(io_err)?;
        let data_start = offset + header.len() as u64;

        let mut crc = crc32fast::Hasher::new();
        let mut sha = Sha256::new();
        let mut seen: u64 = 0;
        let mut buf = vec![0u8; 256 * 1024];
        let compressed = {
            let counting = Counting {
                inner: &mut self.out,
                count: 0,
            };
            match method {
                Method::Store => {
                    let mut sink = counting;
                    pump(data, &mut buf, &mut crc, &mut sha, &mut seen, &mut sink)?;
                    sink.count
                }
                Method::Deflate => {
                    let mut enc = DeflateEncoder::new(counting, Compression::new(DEFLATE_LEVEL));
                    pump(data, &mut buf, &mut crc, &mut sha, &mut seen, &mut enc)?;
                    enc.finish().map_err(io_err)?.count
                }
            }
        };
        if seen != size {
            return Err(PackageError::argument(
                "size_mismatch",
                format!("{name}: declared {size} bytes, source had {seen}"),
            ));
        }
        if !self.zip64 && compressed >= u64::from(u32::MAX) {
            return Err(PackageError::argument(
                "zip64_required",
                "compressed entry too large for a non-ZIP64 container",
            ));
        }
        let crc = crc.finalize();
        // Patch CRC and compressed size into the local header.
        self.out
            .seek(SeekFrom::Start(offset + 14))
            .map_err(io_err)?;
        let mut patch = Vec::with_capacity(8);
        put_u32(&mut patch, crc);
        if !self.zip64 {
            put_u32(&mut patch, compressed as u32);
        }
        self.out.write_all(&patch).map_err(io_err)?;
        if self.zip64 {
            let extra_compressed = LOCAL_HEADER_LEN + name.len() as u64 + 4 + 8;
            self.out
                .seek(SeekFrom::Start(offset + extra_compressed))
                .map_err(io_err)?;
            self.out
                .write_all(&compressed.to_le_bytes())
                .map_err(io_err)?;
        }
        self.pos = data_start + compressed;
        self.out.seek(SeekFrom::Start(self.pos)).map_err(io_err)?;
        self.records.push(CentralRecord {
            name: name.to_owned(),
            method,
            crc,
            compressed,
            size,
            offset,
        });
        Ok(WrittenEntry {
            sha256: hex(&sha.finalize()),
            size,
            compressed,
        })
    }

    /// Central directory and end records. Returns the output and its total length.
    pub fn finish(mut self) -> Result<(W, u64)> {
        let count = self.records.len();
        if !self.zip64 && count > ZIP64_ENTRY_THRESHOLD {
            return Err(PackageError::argument(
                "zip64_required",
                "too many entries for a non-ZIP64 container",
            ));
        }
        let version = self.version();
        let cd_offset = self.pos;
        let mut cd = Vec::with_capacity(count * 110);
        for r in &self.records {
            put_u32(&mut cd, CENTRAL_SIG);
            put_u16(&mut cd, MADE_BY_UNIX | version);
            put_u16(&mut cd, version);
            put_u16(&mut cd, FLAG_UTF8);
            put_u16(&mut cd, r.method.code());
            put_u16(&mut cd, DOS_TIME);
            put_u16(&mut cd, DOS_DATE);
            put_u32(&mut cd, r.crc);
            if self.zip64 {
                put_u32(&mut cd, u32::MAX);
                put_u32(&mut cd, u32::MAX);
            } else {
                put_u32(&mut cd, r.compressed as u32);
                put_u32(&mut cd, r.size as u32);
            }
            put_u16(&mut cd, r.name.len() as u16);
            put_u16(&mut cd, if self.zip64 { 28 } else { 0 });
            put_u16(&mut cd, 0); // comment
            put_u16(&mut cd, 0); // disk start
            put_u16(&mut cd, 0); // internal attributes
            put_u32(&mut cd, UNIX_FILE_MODE << 16);
            put_u32(
                &mut cd,
                if self.zip64 {
                    u32::MAX
                } else {
                    r.offset as u32
                },
            );
            cd.extend_from_slice(r.name.as_bytes());
            if self.zip64 {
                put_u16(&mut cd, ZIP64_EXTRA_ID);
                put_u16(&mut cd, 24);
                put_u64(&mut cd, r.size);
                put_u64(&mut cd, r.compressed);
                put_u64(&mut cd, r.offset);
            }
        }
        let cd_size = cd.len() as u64;
        let mut tail = Vec::with_capacity(100);
        if self.zip64 {
            let eocd64_offset = cd_offset + cd_size;
            put_u32(&mut tail, EOCD64_SIG);
            put_u64(&mut tail, EOCD64_LEN - 12);
            put_u16(&mut tail, MADE_BY_UNIX | VERSION_ZIP64);
            put_u16(&mut tail, VERSION_ZIP64);
            put_u32(&mut tail, 0);
            put_u32(&mut tail, 0);
            put_u64(&mut tail, count as u64);
            put_u64(&mut tail, count as u64);
            put_u64(&mut tail, cd_size);
            put_u64(&mut tail, cd_offset);
            put_u32(&mut tail, LOCATOR_SIG);
            put_u32(&mut tail, 0);
            put_u64(&mut tail, eocd64_offset);
            put_u32(&mut tail, 1);
            put_u32(&mut tail, EOCD_SIG);
            put_u16(&mut tail, 0);
            put_u16(&mut tail, 0);
            put_u16(&mut tail, u16::MAX);
            put_u16(&mut tail, u16::MAX);
            put_u32(&mut tail, u32::MAX);
            put_u32(&mut tail, u32::MAX);
            put_u16(&mut tail, 0);
        } else {
            if cd_offset + cd_size + EOCD_LEN > u64::from(u32::MAX) {
                return Err(PackageError::argument(
                    "zip64_required",
                    "container too large without ZIP64",
                ));
            }
            put_u32(&mut tail, EOCD_SIG);
            put_u16(&mut tail, 0);
            put_u16(&mut tail, 0);
            put_u16(&mut tail, count as u16);
            put_u16(&mut tail, count as u16);
            put_u32(&mut tail, cd_size as u32);
            put_u32(&mut tail, cd_offset as u32);
            put_u16(&mut tail, 0);
        }
        self.out.write_all(&cd).map_err(io_err)?;
        self.out.write_all(&tail).map_err(io_err)?;
        self.out.flush().map_err(io_err)?;
        let total = cd_offset + cd_size + tail.len() as u64;
        Ok((self.out, total))
    }
}

fn pump(
    data: &mut dyn Read,
    buf: &mut [u8],
    crc: &mut crc32fast::Hasher,
    sha: &mut Sha256,
    seen: &mut u64,
    sink: &mut dyn Write,
) -> Result<()> {
    loop {
        let n = match data.read(buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(io_err(e)),
        };
        crc.update(&buf[..n]);
        sha.update(&buf[..n]);
        *seen += n as u64;
        sink.write_all(&buf[..n]).map_err(io_err)?;
    }
}

/* ------------------------------------------------------------------ reader */

/// One verified central-directory entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub method: Method,
    pub crc32: u32,
    pub compressed_size: u64,
    pub size: u64,
    pub header_offset: u64,
    pub data_offset: u64,
}

/// A structurally verified container. Entries are in physical order.
pub struct ZipReader<R: Read + Seek> {
    inner: R,
    len: u64,
    zip64: bool,
    entries: Vec<Entry>,
    index: HashMap<String, usize>,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| invalid("truncated", "a ZIP record is truncated"))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_le_bytes(a))
    }
}

fn read_exact_at<R: Read + Seek>(r: &mut R, offset: u64, n: usize) -> Result<Vec<u8>> {
    r.seek(SeekFrom::Start(offset)).map_err(io_err)?;
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).map_err(|e| {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            invalid("truncated", "the container is truncated")
        } else {
            io_err(e)
        }
    })?;
    Ok(buf)
}

/// Parse the ZIP64 extended-information extra field; anything else is refused.
fn parse_extra(extra: &[u8], zip64: bool, want: usize, what: &str) -> Result<Vec<u64>> {
    if !zip64 {
        if !extra.is_empty() {
            let id = if extra.len() >= 2 {
                u16::from_le_bytes([extra[0], extra[1]])
            } else {
                0
            };
            return Err(invalid(
                "extra_field",
                format!("{what} carries an extra field (0x{id:04x}); the strict subset has none"),
            ));
        }
        return Ok(Vec::new());
    }
    let mut c = Cursor::new(extra);
    let id = c.u16()?;
    let len = c.u16()? as usize;
    if id != ZIP64_EXTRA_ID {
        return Err(invalid(
            "extra_field",
            format!("{what} carries extra field 0x{id:04x}; only ZIP64 (0x0001) is allowed"),
        ));
    }
    if len != want * 8 || extra.len() != 4 + len {
        return Err(invalid(
            "zip64_inconsistent",
            format!(
                "{what}: ZIP64 extra field has {len} bytes, expected {}",
                want * 8
            ),
        ));
    }
    (0..want).map(|_| c.u64()).collect()
}

impl<R: Read + Seek> ZipReader<R> {
    /// Open and structurally verify a container. Reads only the end records,
    /// the central directory and every local header (no member data).
    pub fn open(mut inner: R, limits: &Limits) -> Result<Self> {
        let len = inner.seek(SeekFrom::End(0)).map_err(io_err)?;
        if len > limits.max_full_bytes {
            return Err(PackageError::new(
                ErrorCode::TooLarge,
                "container_size",
                format!(
                    "the container is {len} bytes; this installation accepts at most {}",
                    limits.max_full_bytes
                ),
            ));
        }
        if len < EOCD_LEN {
            return Err(invalid("truncated", "too short to be a ZIP container"));
        }
        let eocd = read_exact_at(&mut inner, len - EOCD_LEN, EOCD_LEN as usize)?;
        let mut c = Cursor::new(&eocd);
        if c.u32()? != EOCD_SIG {
            return Err(Self::diagnose_tail(&mut inner, len));
        }
        let disk = c.u16()?;
        let cd_disk = c.u16()?;
        let n_disk = c.u16()?;
        let n_total = c.u16()?;
        let cd_size32 = c.u32()?;
        let cd_off32 = c.u32()?;
        let comment_len = c.u16()?;
        if comment_len != 0 {
            return Err(invalid("comment", "the archive carries a comment"));
        }
        if disk != 0 || cd_disk != 0 || n_disk != n_total {
            return Err(invalid(
                "multi_disk",
                "multi-disk archives are not accepted",
            ));
        }
        let sentinels = [
            n_total == u16::MAX,
            cd_size32 == u32::MAX,
            cd_off32 == u32::MAX,
        ];
        let zip64 = sentinels.iter().all(|s| *s);
        if !zip64 && sentinels.iter().any(|s| *s) {
            return Err(invalid(
                "zip64_inconsistent",
                "the end record mixes ZIP64 sentinels with real values",
            ));
        }
        let (count, cd_size, cd_offset, cd_end) = if zip64 {
            if len < EOCD_LEN + LOCATOR_LEN + EOCD64_LEN {
                return Err(invalid(
                    "zip64_inconsistent",
                    "ZIP64 end records are missing",
                ));
            }
            let locator_at = len - EOCD_LEN - LOCATOR_LEN;
            let loc = read_exact_at(&mut inner, locator_at, LOCATOR_LEN as usize)?;
            let mut c = Cursor::new(&loc);
            if c.u32()? != LOCATOR_SIG {
                return Err(invalid(
                    "zip64_inconsistent",
                    "the ZIP64 locator is missing",
                ));
            }
            let eocd64_disk = c.u32()?;
            let eocd64_at = c.u64()?;
            let disks = c.u32()?;
            if eocd64_disk != 0 || disks != 1 {
                return Err(invalid(
                    "multi_disk",
                    "multi-disk archives are not accepted",
                ));
            }
            if eocd64_at != locator_at - EOCD64_LEN {
                return Err(invalid(
                    "zip64_inconsistent",
                    "the ZIP64 end record is not immediately before its locator",
                ));
            }
            let rec = read_exact_at(&mut inner, eocd64_at, EOCD64_LEN as usize)?;
            let mut c = Cursor::new(&rec);
            if c.u32()? != EOCD64_SIG {
                return Err(invalid(
                    "zip64_inconsistent",
                    "the ZIP64 end record is missing",
                ));
            }
            let size = c.u64()?;
            let _made_by = c.u16()?;
            let _needed = c.u16()?;
            let disk = c.u32()?;
            let cd_disk = c.u32()?;
            let n_disk = c.u64()?;
            let n_total = c.u64()?;
            let cd_size = c.u64()?;
            let cd_offset = c.u64()?;
            if size != EOCD64_LEN - 12 {
                return Err(invalid(
                    "zip64_inconsistent",
                    "the ZIP64 end record carries extensible data",
                ));
            }
            if disk != 0 || cd_disk != 0 || n_disk != n_total {
                return Err(invalid(
                    "multi_disk",
                    "multi-disk archives are not accepted",
                ));
            }
            let count = usize::try_from(n_total).map_err(|_| {
                PackageError::new(
                    ErrorCode::LimitExceeded,
                    "entry_count",
                    "entry count overflows",
                )
            })?;
            (count, cd_size, cd_offset, eocd64_at)
        } else {
            (
                usize::from(n_total),
                u64::from(cd_size32),
                u64::from(cd_off32),
                len - EOCD_LEN,
            )
        };
        if count > limits.max_entries {
            return Err(PackageError::new(
                ErrorCode::LimitExceeded,
                "entry_count",
                format!(
                    "the container has {count} entries; the limit is {}",
                    limits.max_entries
                ),
            ));
        }
        if cd_offset.checked_add(cd_size) != Some(cd_end) {
            return Err(invalid(
                "layout",
                "the central directory does not end where the end records begin (gap or trailing data)",
            ));
        }
        let cd_len = usize::try_from(cd_size)
            .ok()
            .filter(|n| *n <= count * (CENTRAL_HEADER_LEN + 0xFFFF * 3))
            .ok_or_else(|| invalid("layout", "the central directory size is implausible"))?;
        let cd = read_exact_at(&mut inner, cd_offset, cd_len)?;
        let mut c = Cursor::new(&cd);
        let version = if zip64 {
            VERSION_ZIP64
        } else {
            VERSION_DEFAULT
        };
        let mut entries: Vec<Entry> = Vec::with_capacity(count);
        let mut index = HashMap::with_capacity(count);
        let mut total_uncompressed: u64 = 0;
        for _ in 0..count {
            if c.u32()? != CENTRAL_SIG {
                return Err(invalid(
                    "layout",
                    "the central directory holds fewer entries than the end record declares",
                ));
            }
            let made_by = c.u16()?;
            let needed = c.u16()?;
            let flags = c.u16()?;
            let method = c.u16()?;
            let time = c.u16()?;
            let date = c.u16()?;
            let crc32 = c.u32()?;
            let comp32 = c.u32()?;
            let size32 = c.u32()?;
            let name_len = c.u16()? as usize;
            let extra_len = c.u16()? as usize;
            let comment_len = c.u16()?;
            let disk_start = c.u16()?;
            let internal = c.u16()?;
            let external = c.u32()?;
            let off32 = c.u32()?;
            let name_bytes = c.take(name_len)?;
            let extra = c.take(extra_len)?;
            let name = std::str::from_utf8(name_bytes)
                .map_err(|_| invalid("name_not_allowed", "a member name is not UTF-8"))?
                .to_owned();
            let what = format!("entry {name:?}");
            if index.contains_key(&name) {
                return Err(invalid("duplicate_name", format!("{name:?} appears twice")).at(name));
            }
            if flags & 0x0001 != 0 || flags & 0x0040 != 0 {
                return Err(invalid("encrypted", format!("{what} is encrypted")).at(name));
            }
            if flags & 0x0008 != 0 {
                return Err(invalid(
                    "data_descriptor",
                    format!("{what} uses a data descriptor; sizes must be in the local header"),
                )
                .at(name));
            }
            if flags != FLAG_UTF8 {
                return Err(invalid("flags", format!("{what} has flags 0x{flags:04x}")).at(name));
            }
            let method = match method {
                0 => Method::Store,
                8 => Method::Deflate,
                m => {
                    return Err(invalid(
                        "method_not_allowed",
                        format!(
                        "{what} uses compression method {m}; only STORE and DEFLATE are accepted"
                    ),
                    )
                    .at(name))
                }
            };
            let mode = external >> 16;
            match mode & 0o170_000 {
                0o120_000 => {
                    return Err(invalid("symlink", format!("{what} is a symlink")).at(name))
                }
                0o040_000 => {
                    return Err(invalid("directory", format!("{what} is a directory")).at(name))
                }
                _ => {}
            }
            if name.ends_with('/') {
                return Err(invalid("directory", format!("{what} is a directory")).at(name));
            }
            if !is_allowed_name(&name) {
                return Err(invalid(
                    "name_not_allowed",
                    format!("{name:?} is not an allowed member name"),
                )
                .at(name));
            }
            if external != UNIX_FILE_MODE << 16 || internal != 0 {
                return Err(invalid(
                    "attributes",
                    format!("{what} has mode {mode:o}; members are regular files 0100644"),
                )
                .at(name));
            }
            if made_by >> 8 != 3 || needed != version || made_by & 0xff != version {
                return Err(invalid(
                    "version",
                    format!("{what} was not written by the strict writer (made by 0x{made_by:04x}, needs {needed})"),
                )
                .at(name));
            }
            if time != DOS_TIME || date != DOS_DATE {
                return Err(invalid(
                    "timestamp",
                    format!("{what} carries a timestamp; members use 1980-01-01 00:00"),
                )
                .at(name));
            }
            if comment_len != 0 {
                return Err(invalid("comment", format!("{what} carries a comment")).at(name));
            }
            if disk_start != 0 {
                return Err(
                    invalid("multi_disk", format!("{what} starts on another disk")).at(name),
                );
            }
            let (compressed_size, size, header_offset) = if zip64 {
                if comp32 != u32::MAX || size32 != u32::MAX || off32 != u32::MAX {
                    return Err(invalid(
                        "zip64_inconsistent",
                        format!("{what}: ZIP64 container with 32-bit header values"),
                    )
                    .at(name));
                }
                let v = parse_extra(extra, true, 3, &what).map_err(|e| e.at(name.clone()))?;
                (v[1], v[0], v[2])
            } else {
                parse_extra(extra, false, 0, &what).map_err(|e| e.at(name.clone()))?;
                (u64::from(comp32), u64::from(size32), u64::from(off32))
            };
            if method == Method::Store && compressed_size != size {
                return Err(invalid(
                    "header_mismatch",
                    format!("{what} is STOREd but its sizes differ"),
                )
                .at(name));
            }
            if method == Method::Deflate
                && size > limits.ratio_floor_bytes
                && size / compressed_size.max(1) > limits.max_deflate_ratio
            {
                return Err(PackageError::new(
                    ErrorCode::LimitExceeded,
                    "deflate_ratio",
                    format!(
                        "{what} inflates {compressed_size} bytes to {size} (limit {}:1)",
                        limits.max_deflate_ratio
                    ),
                )
                .at(name));
            }
            total_uncompressed = total_uncompressed.saturating_add(size);
            index.insert(name.clone(), entries.len());
            entries.push(Entry {
                name,
                method,
                crc32,
                compressed_size,
                size,
                header_offset,
                data_offset: 0,
            });
        }
        if c.at != cd.len() {
            return Err(invalid(
                "layout",
                "the central directory holds more bytes than its entries",
            ));
        }
        if zip64 != zip64_required(count, total_uncompressed) {
            return Err(invalid(
                "zip64_inconsistent",
                if zip64 {
                    "the container uses ZIP64 although its content does not need it"
                } else {
                    "the container needs ZIP64 but does not use it"
                },
            ));
        }
        // Local headers: entries tile [0, cd_offset) in central order.
        let mut expected = 0u64;
        for e in &mut entries {
            if e.header_offset != expected {
                let (rule, msg) = if expected == 0 {
                    ("prefix_data", "bytes precede the first entry")
                } else if e.header_offset < expected {
                    ("overlap", "entries overlap")
                } else {
                    ("layout", "unreferenced bytes lie between entries")
                };
                return Err(invalid(rule, format!("{msg} (at {:?})", e.name)).at(e.name.clone()));
            }
            let extra_len: usize = if zip64 { 20 } else { 0 };
            let head_len = LOCAL_HEADER_LEN as usize + e.name.len() + extra_len;
            let head = read_exact_at(&mut inner, e.header_offset, head_len)?;
            let mut c = Cursor::new(&head);
            let mismatch = |field: &str| {
                invalid(
                    "header_mismatch",
                    format!(
                        "the local header of {:?} disagrees with the central directory ({field})",
                        e.name
                    ),
                )
                .at(e.name.clone())
            };
            if c.u32()? != LOCAL_SIG {
                return Err(mismatch("signature"));
            }
            if c.u16()? != version {
                return Err(mismatch("version"));
            }
            if c.u16()? != FLAG_UTF8 {
                return Err(mismatch("flags"));
            }
            if c.u16()? != e.method.code() {
                return Err(mismatch("method"));
            }
            if c.u16()? != DOS_TIME || c.u16()? != DOS_DATE {
                return Err(mismatch("timestamp"));
            }
            if c.u32()? != e.crc32 {
                return Err(mismatch("crc"));
            }
            let comp32 = c.u32()?;
            let size32 = c.u32()?;
            let name_len = c.u16()? as usize;
            let local_extra_len = c.u16()? as usize;
            if name_len != e.name.len() || local_extra_len != extra_len {
                return Err(mismatch("name or extra length"));
            }
            if c.take(name_len)? != e.name.as_bytes() {
                return Err(mismatch("name"));
            }
            if zip64 {
                if comp32 != u32::MAX || size32 != u32::MAX {
                    return Err(mismatch("ZIP64 sentinels"));
                }
                let v = parse_extra(c.take(extra_len)?, true, 2, &e.name)?;
                if v[0] != e.size || v[1] != e.compressed_size {
                    return Err(mismatch("sizes"));
                }
            } else if u64::from(comp32) != e.compressed_size || u64::from(size32) != e.size {
                return Err(mismatch("sizes"));
            }
            e.data_offset = e.header_offset + head_len as u64;
            expected = e
                .data_offset
                .checked_add(e.compressed_size)
                .ok_or_else(|| invalid("layout", "entry sizes overflow"))?;
        }
        if expected != cd_offset {
            return Err(invalid(
                if expected > cd_offset {
                    "overlap"
                } else {
                    "layout"
                },
                "entry data does not end where the central directory begins",
            ));
        }
        Ok(Self {
            inner,
            len,
            zip64,
            entries,
            index,
        })
    }

    /// Why the end record is not the last 22 bytes: a comment, or trailing data.
    fn diagnose_tail(inner: &mut R, len: u64) -> PackageError {
        let window = len.min(EOCD_LEN + 0xFFFF + 1024);
        let Ok(tail) = read_exact_at(inner, len - window, window as usize) else {
            return invalid("not_a_zip", "no end-of-central-directory record");
        };
        let sig = EOCD_SIG.to_le_bytes();
        match tail.windows(4).rposition(|w| w == sig) {
            Some(at) if at + EOCD_LEN as usize <= tail.len() => {
                let comment_len = u16::from_le_bytes([tail[at + 20], tail[at + 21]]) as usize;
                if comment_len > 0 && at + EOCD_LEN as usize + comment_len == tail.len() {
                    invalid("comment", "the archive carries a comment")
                } else {
                    invalid(
                        "trailing_data",
                        "bytes follow the end-of-central-directory record",
                    )
                }
            }
            _ => invalid("not_a_zip", "no end-of-central-directory record"),
        }
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn zip64(&self) -> bool {
        self.zip64
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn entry(&self, name: &str) -> Option<&Entry> {
        self.index.get(name).map(|i| &self.entries[*i])
    }

    /// Stream an entry's inflated bytes into `sink`, checking the declared
    /// size (inflation stops there; one more byte is an error), the CRC and
    /// that the compressed data is consumed exactly. Returns the sha256.
    pub fn stream(&mut self, name: &str, sink: &mut dyn Write) -> Result<String> {
        let e = self.entry(name).cloned().ok_or_else(|| {
            invalid(
                "member_missing",
                format!("{name:?} is not in the container"),
            )
        })?;
        self.inner
            .seek(SeekFrom::Start(e.data_offset))
            .map_err(io_err)?;
        let take = (&mut self.inner).take(e.compressed_size);
        let mut crc = crc32fast::Hasher::new();
        let mut sha = Sha256::new();
        let mut total: u64 = 0;
        let mut buf = vec![0u8; 256 * 1024];
        let overrun = || {
            PackageError::container(
                "inflate_overrun",
                format!(
                    "{name:?} inflates past its declared size of {} bytes",
                    e.size
                ),
            )
            .at(name)
        };
        let mut feed = |chunk: &[u8], total: &mut u64| -> Result<()> {
            *total += chunk.len() as u64;
            if *total > e.size {
                return Err(overrun());
            }
            crc.update(chunk);
            sha.update(chunk);
            sink.write_all(chunk).map_err(io_err)
        };
        match e.method {
            Method::Store => {
                let mut r = take;
                loop {
                    let n = r.read(&mut buf).map_err(io_err)?;
                    if n == 0 {
                        break;
                    }
                    feed(&buf[..n], &mut total)?;
                }
            }
            Method::Deflate => {
                let mut dec = flate2::bufread::DeflateDecoder::new(BufReader::new(take));
                loop {
                    let n = dec.read(&mut buf).map_err(|err| {
                        PackageError::container("inflate_error", format!("{name:?}: {err}"))
                            .at(name)
                    })?;
                    if n == 0 {
                        break;
                    }
                    feed(&buf[..n], &mut total)?;
                }
                let consumed = dec.total_in();
                let mut rest = dec.into_inner();
                let leftover = rest.fill_buf().map_err(io_err)?.len();
                if consumed != e.compressed_size || leftover != 0 {
                    return Err(PackageError::container(
                        "trailing_compressed_data",
                        format!("{name:?}: the DEFLATE stream ends before its entry does"),
                    )
                    .at(name));
                }
            }
        }
        if total != e.size {
            return Err(PackageError::container(
                "inflate_underrun",
                format!("{name:?} inflates to {total} bytes, declared {}", e.size),
            )
            .at(name));
        }
        if crc.finalize() != e.crc32 {
            return Err(PackageError::digest("crc", format!("{name:?} fails its CRC-32")).at(name));
        }
        Ok(hex(&sha.finalize()))
    }

    /// Read an entry fully (at most `max` bytes). Returns bytes and sha256.
    pub fn read(&mut self, name: &str, max: u64) -> Result<(Vec<u8>, String)> {
        let size = self.entry(name).map(|e| e.size).ok_or_else(|| {
            invalid(
                "member_missing",
                format!("{name:?} is not in the container"),
            )
        })?;
        if size > max {
            return Err(PackageError::new(
                ErrorCode::LimitExceeded,
                "member_size",
                format!("{name:?} is {size} bytes; the limit is {max}"),
            )
            .at(name));
        }
        let mut out = Vec::with_capacity(size as usize);
        let sha = self.stream(name, &mut out)?;
        Ok((out, sha))
    }

    pub fn into_inner(self) -> R {
        self.inner
    }
}

/* ------------------------------------------------------------------ helpers */

pub(crate) fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

fn put_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn put_u64(v: &mut Vec<u8>, x: u64) {
    v.extend_from_slice(&x.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor as IoCursor;

    fn write(entries: &[(&str, Method, &[u8])], zip64: bool) -> Vec<u8> {
        let mut w = ZipWriter::new(IoCursor::new(Vec::new()), zip64).unwrap();
        for (name, method, data) in entries {
            w.add(name, *method, data.len() as u64, &mut &data[..])
                .unwrap();
        }
        w.finish().unwrap().0.into_inner()
    }

    #[test]
    fn round_trip_both_methods() {
        let json = br#"{"a":1,"b":[1,2,3],"c":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#;
        let bytes = write(
            &[
                ("manifest.json", Method::Deflate, json),
                (
                    "simulation/trace.json.gz",
                    Method::Store,
                    b"\x1f\x8bnot really",
                ),
            ],
            false,
        );
        let mut r = ZipReader::open(IoCursor::new(bytes.clone()), &Limits::default()).unwrap();
        assert_eq!(r.entries().len(), 2);
        let (got, _) = r.read("manifest.json", 1 << 20).unwrap();
        assert_eq!(got, json);
        // Deterministic.
        assert_eq!(
            bytes,
            write(
                &[
                    ("manifest.json", Method::Deflate, json),
                    (
                        "simulation/trace.json.gz",
                        Method::Store,
                        b"\x1f\x8bnot really"
                    ),
                ],
                false
            )
        );
    }

    #[test]
    fn zip64_is_refused_when_not_needed() {
        let bytes = write(&[("manifest.json", Method::Deflate, b"{}")], true);
        let err = ZipReader::open(IoCursor::new(bytes), &Limits::default())
            .err()
            .unwrap();
        assert_eq!(err.rule, "zip64_inconsistent");
    }

    #[test]
    fn zip64_entry_count_branch_round_trips() {
        // 65,536 entries forces ZIP64 by count; content is tiny.
        let mut w = ZipWriter::new(IoCursor::new(Vec::new()), true).unwrap();
        let mut names = Vec::new();
        for i in 0..=ZIP64_ENTRY_THRESHOLD as u32 {
            let data = i.to_le_bytes();
            let sha = hex(&Sha256::digest(data));
            let name = crate::names::blob_path(&sha);
            w.add(&name, Method::Store, 4, &mut &data[..]).unwrap();
            names.push(name);
        }
        let bytes = w.finish().unwrap().0.into_inner();
        let mut r = ZipReader::open(IoCursor::new(bytes), &Limits::default()).unwrap();
        assert!(r.zip64());
        assert_eq!(r.entries().len(), ZIP64_ENTRY_THRESHOLD + 1);
        let (data, _) = r.read(&names[7], 16).unwrap();
        assert_eq!(data, 7u32.to_le_bytes());
    }
}
