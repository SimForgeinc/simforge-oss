"""Length-prefixed MessagePack framing used by SimForge model endpoints."""
from __future__ import annotations

import socket
import struct
from typing import Any

import msgpack

_LENGTH = struct.Struct("<I")
MAX_FRAME = 512 * 1024 * 1024


def send_msg(sock: socket.socket, value: Any) -> None:
    payload = msgpack.packb(value, use_bin_type=True)
    sock.sendall(_LENGTH.pack(len(payload)) + payload)


def _recv_exact(sock: socket.socket, count: int) -> bytes | None:
    out = bytearray()
    while len(out) < count:
        chunk = sock.recv(min(count - len(out), 1 << 20))
        if not chunk:
            return None
        out.extend(chunk)
    return bytes(out)


def recv_msg(sock: socket.socket) -> Any | None:
    header = _recv_exact(sock, _LENGTH.size)
    if header is None:
        return None
    (length,) = _LENGTH.unpack(header)
    if length > MAX_FRAME:
        raise ValueError(f"message is too large: {length} > {MAX_FRAME}")
    payload = _recv_exact(sock, length)
    if payload is None:
        return None
    return msgpack.unpackb(payload, raw=False, strict_map_key=False)
