"""shm ring writer, byte-compatible with `renderer/service/src/shm.rs`.

Layout (all little-endian; reader of record: `simforge_native/bundles.py`):
  meta page 4096 B: [0..8) magic "UNISHRI1", [8..16) write_cursor_total,
                    [16..24) bundle seq (seqlock), [24..32) bundle record offset,
                    [32..40) bundle payload len, [40..48) bundle sim_tick
  record: 128 B header (magic u64, version u32=1, width u32, height u32, format u32,
          tick u64, payload_len u64, sensor_id[56] @40, pass[32] @96) + payload
  bundle payload: "SFBNDL01" u64, sim_tick u64, start_cursor u64, n u32, entries_crc u32,
          then 96 B entries (id[48], pass[16], payload_offset u64, payload_len u64,
          width u32, height u32, format u32, digest u32 = CRC32 of payload bytes)

Format tags 1..6 are the native service's; this backend publishes 1 (rgba8), 2 (depth32f), 4
(bundle) and its own versioned addition 7 `rgb8`: tightly packed `width*3` rows (the only
non-256-aligned image format), declared so readers can derive the stride from the tag alone.
No JPEG record is ever written here (the backend has no encoder; the service refuses the op).
"""
from __future__ import annotations

import mmap
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

META_BYTES = 4096
RECORD_HEADER_BYTES = 128
RING_MAGIC = 0x554E4953_48524931
BUNDLE_MAGIC = int.from_bytes(b"SFBNDL01", "little")
BUNDLE_SENSOR_ID = "__bundle__"

FORMAT_RGBA8 = 1
FORMAT_DEPTH32F = 2
FORMAT_BUNDLE = 4
FORMAT_RGB8 = 7  # versioned addition (simforge.splat-backend/v1)

FORMAT_TAGS = {"rgba8": FORMAT_RGBA8, "depth32f": FORMAT_DEPTH32F, "rgb8": FORMAT_RGB8}


def align256(n: int) -> int:
    return -(-n // 256) * 256


def row_stride(fmt: str, width: int) -> int:
    """Bytes per row as the readers derive it from the format tag."""
    if fmt == "rgb8":
        return width * 3
    if fmt in ("rgba8", "depth32f"):
        return align256(width * 4)
    raise ValueError(fmt)


@dataclass
class Entry:
    sensor_id: str
    pass_: str
    record_offset: int
    payload_len: int
    width: int
    height: int
    fmt: str
    digest: int

    @property
    def payload_offset(self) -> int:
        return self.record_offset + RECORD_HEADER_BYTES


class RingWriter:
    def __init__(self, path: str | Path, capacity_bytes: int):
        if capacity_bytes < META_BYTES + 1024:
            raise ValueError("shm capacity too small")
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "wb") as f:
            f.truncate(capacity_bytes)
        self._file = open(self.path, "r+b")
        self.map = mmap.mmap(self._file.fileno(), capacity_bytes)
        self.capacity = capacity_bytes
        self.cursor_total = META_BYTES
        self.map[0:8] = struct.pack("<Q", RING_MAGIC)
        self.map[8:16] = struct.pack("<Q", 0)
        self.map[16:48] = bytes(32)

    @property
    def usable(self) -> int:
        return self.capacity - META_BYTES

    def close(self) -> None:
        self.map.flush()
        self.map.close()
        self._file.close()

    def publish(self, sensor_id: str, pass_: str, width: int, height: int, fmt_tag: int, tick: int, payload) -> int:
        """Write one record; returns its physical (record) offset. `payload` is bytes-like."""
        n = len(payload)
        record_len = RECORD_HEADER_BYTES + n
        if record_len > self.usable:
            raise ValueError(f"record {record_len} bytes exceeds ring usable capacity {self.usable}")
        pos = self.cursor_total % self.capacity
        if pos < META_BYTES or pos + record_len > self.capacity:
            start = META_BYTES
        else:
            start = pos
        if start == META_BYTES and pos != META_BYTES:
            generation = self.cursor_total // self.capacity
            self.cursor_total = (generation + 1) * self.capacity + META_BYTES
        header = bytearray(RECORD_HEADER_BYTES)
        struct.pack_into("<QIIIIQQ", header, 0, RING_MAGIC, 1, width, height, fmt_tag, tick, n)
        sid = sensor_id.encode()[:56]
        header[40:40 + len(sid)] = sid
        p = pass_.encode()[:32]
        header[96:96 + len(p)] = p
        self.map[start:start + RECORD_HEADER_BYTES] = bytes(header)
        if not isinstance(payload, _Zeros):
            self.map[start + RECORD_HEADER_BYTES:start + record_len] = payload
        after = self.cursor_total + record_len
        self.map[8:16] = struct.pack("<Q", after)
        self.cursor_total = after
        return start

    def publish_frame(self, sensor_id: str, pass_: str, width: int, height: int, fmt: str, tick: int, payload) -> Entry:
        off = self.publish(sensor_id, pass_, width, height, FORMAT_TAGS[fmt], tick, payload)
        return Entry(sensor_id, pass_, off, len(payload), width, height, fmt, zlib.crc32(payload) & 0xFFFFFFFF)

    def reserve(self, sensor_id: str, pass_: str, width: int, height: int, fmt_tag: int, tick: int, n: int) -> int:
        """Write a record header for an n-byte payload and return the record offset; the caller
        fills the payload through `payload_view` (e.g. a direct device->shm tensor copy)."""
        return self.publish(sensor_id, pass_, width, height, fmt_tag, tick, _Zeros(n))

    def payload_view(self, record_offset: int, n: int) -> memoryview:
        return memoryview(self.map)[record_offset + RECORD_HEADER_BYTES:record_offset + RECORD_HEADER_BYTES + n]

    def entry_for(self, sensor_id: str, pass_: str, record_offset: int, n: int, width: int, height: int, fmt: str) -> Entry:
        return Entry(sensor_id, pass_, record_offset, n, width, height, fmt, zlib.crc32(self.payload_view(record_offset, n)) & 0xFFFFFFFF)


    def publish_bundle(self, sim_tick: int, start_cursor: int, entries: list[Entry]) -> tuple[int, int]:
        table = bytearray()
        for e in entries:
            b = bytearray(96)
            sid = e.sensor_id.encode()[:48]
            b[0:len(sid)] = sid
            p = e.pass_.encode()[:16]
            b[48:48 + len(p)] = p
            struct.pack_into("<QQIIII", b, 64, e.payload_offset, e.payload_len, e.width, e.height, FORMAT_TAGS[e.fmt], e.digest)
            table += b
        crc = zlib.crc32(bytes(table)) & 0xFFFFFFFF
        payload = struct.pack("<QQQII", BUNDLE_MAGIC, sim_tick, start_cursor, len(entries), crc) + bytes(table)
        off = self.publish(BUNDLE_SENSOR_ID, "bundle", len(entries), 0, FORMAT_BUNDLE, sim_tick, payload)
        seq0 = struct.unpack_from("<Q", self.map, 16)[0]
        self.map[16:24] = struct.pack("<Q", seq0 + 1)
        self.map[24:48] = struct.pack("<QQQ", off, len(payload), sim_tick)
        self.map[16:24] = struct.pack("<Q", seq0 + 2)
        return off, len(payload)


class _Zeros:
    """Length-only payload stand-in for `reserve` (the bytes are written by the caller)."""

    def __init__(self, n: int):
        self.n = n

    def __len__(self) -> int:
        return self.n
