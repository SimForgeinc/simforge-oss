"""Zero-copy views of the kernel Episode camera observation.

This adapter does not own a renderer, scene assembly, clock or render loop.
Configure the Episode's ``cameras`` channel, then consume its reset/step
observation here. The external-physics (MuJoCo) renderer-only transport lives
in ``simforge_native.embedded_sensors.ExternalSensorRig`` instead.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np

from .native import Episode, FrameRef


@dataclass(frozen=True)
class HostFrame:
    """One borrowed camera pass. Never access ``array`` after ``release()``."""

    sensor_id: str
    pass_name: str
    tick: int
    array: np.ndarray
    frame: FrameRef
    digest: str
    sha256: str

    def release(self) -> None:
        self.frame.release()

    def __enter__(self) -> "HostFrame":
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


class BevySensorRig:
    """Consume camera leases already produced synchronously by an Episode.

    ``frames(observation)`` accepts the reset observation or step ``obs``.
    During reset's warmup callback pass the supplied ``references``; calling
    back into a mutably borrowed Episode is deliberately unnecessary.
    Release all frames before the next Episode advance. Copy explicitly if
    a model needs a longer image history.
    """

    def __init__(self, episode: Episode) -> None:
        self.episode = episode
        self._frames: list[HostFrame] = []

    def frames(self, observation: Mapping[str, Any], references: Sequence[FrameRef] | None = None) -> list[HostFrame]:
        rows = observation.get("cameras")
        if rows is None:
            raise ValueError("Episode observation has no cameras channel")
        if any(not frame.frame.released for frame in self._frames):
            raise RuntimeError("release previous camera leases before consuming another observation")
        refs = list(references) if references is not None else [self.episode.frame(int(row["frame"]["id"])) for row in rows]
        self._frames = []
        try:
            if len(refs) != len(rows):
                raise ValueError("camera observation and FrameRef count disagree")
            for row, ref in zip(rows, refs):
                meta = row["frame"]
                if ref.id != int(meta["id"]):
                    raise ValueError("camera observation and FrameRef identity disagree")
                width, height = int(row["width"]), int(row["height"])
                stride = int(meta["rowStride"])
                if meta["format"] == "depth32f":
                    array = np.ndarray((height, width), dtype="<f4", buffer=ref.buffer(), strides=(stride, 4))
                else:
                    array = np.ndarray((height, width, 4), dtype=np.uint8, buffer=ref.buffer(), strides=(stride, 4, 1))
                array.setflags(write=False)
                self._frames.append(HostFrame(str(row["sensorId"]), str(row["pass"]), int(meta["tick"]),
                                              array, ref, str(meta["digest"]), str(meta["sha256"])))
        except BaseException:
            for ref in refs:
                ref.release()
            self._frames.clear()
            raise
        return self._frames

    def close(self) -> None:
        """Release this adapter's leases; Episode owns renderer teardown."""
        for frame in self._frames:
            frame.release()
        self._frames.clear()

    def __enter__(self) -> "BevySensorRig":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
