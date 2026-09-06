"""Wire-level constants and pure request validation of the splat backend (no torch/CUDA imports;
safe for `capabilities --no-probe` and job parameter parsing)."""
from __future__ import annotations

from .prerequisites import CapabilityError

PROTOCOL_VERSION = 5
SERVICE_TRANSPORT = "host-shm"
TENSOR_TRANSPORT = "in-process-torch"
JOB_TRANSPORT = "host-files"
WORKLOAD = "simforge.render-bundle-nurec/v1"

# Passes this backend produces. `semantic` (a legend-derived pass of the Bevy service) has no
# counterpart: a reconstruction carries no semantic legend, so it is refused, never faked.
PASSES = ("rgb", "depth", "id")
# Host-visible output formats for the rgb pass; jpeg is refused (no encoder in this backend).
RGB_OUTPUT_FORMATS = ("rgb8", "rgba8")

# V5 ops the socket service cannot serve and why (answered as explicit errors).
UNSUPPORTED_OPS = {
    "load": "the splat service renders imported scene bundles selected by scene-state mapId; there are no glTF tiles to load",
    "render": "the per-frame `render` op is not served; use render_bundle",
    "encode_jpeg": "no JPEG encoder in the splat backend; request rgb8/rgba8 frames and encode client-side",
    "set_lighting": "a reconstruction's lighting is captured, not authored; nothing to re-light",
    "get_state": "no lighting/anti-alias state exists to read back",
    "open_device_stream": f"device streams need an in-process consumer: simforge_splat.tensor.NuRecTensorSensor ({TENSOR_TRANSPORT}); this socket publishes host shm only",
    "export_device_stream": "no exportable device handles: NuRec outputs are PyTorch allocations, not external Vulkan memory; use the in-process tensor path",
    "close_device_stream": "no device streams exist on the socket path",
}


def parse_passes(passes: list[str] | None) -> tuple[str, ...]:
    """Canonical (rgb, depth, id) order of the requested subset; unknown or unserved passes fail."""
    requested = list(passes) if passes is not None else ["rgb"]
    for name in requested:
        if name == "semantic":
            raise CapabilityError("semantic pass is not served by the splat backend: the reconstruction has no semantic legend")
        if name not in PASSES:
            raise CapabilityError(f"unknown bundle pass {name!r}")
    return tuple(p for p in PASSES if p in requested)
