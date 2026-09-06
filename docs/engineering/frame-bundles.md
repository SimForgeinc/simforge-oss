# Frame bundles (F4): atomic multi-camera sensor frames over the shm ring

Status: implemented (lane/shmbridge). Owner: ShmBridge. Consumed by PolicyStep's
`frameBundle` observation ref (`packages/training-env/src/policy-step.ts`).

The native render service (`renderer/service`) publishes per-tick, per-camera
frames into a single-writer shared-memory ring (`renderer/service/src/shm.rs`).
F4 adds *bundles*: one atomic record per sim tick covering ALL rig cameras, so
a policy runner can consume a calibrated multi-camera frame set zero-copy and
can never observe a torn (partially written) tick.

## Wire op: `render_bundle` (protocol V5)

Request (`{i, op:"render_bundle", ...}` over the u32-LE length-prefixed
msgpack socket):

| field | type | semantics |
|---|---|---|
| `sim_tick` | u64 | bundle identity; becomes `tick_id` of every record |
| `cameras` | `ServiceCamera[]?` | upserts the retained rig (registration order kept). Omit on the hot loop; the rig persists across calls. `reset_cameras` clears it. A camera re-sent with a different size/FOV/profile is re-registered in place. Mounted (`attach`) cameras exclude their own host actor from their view only. |
| `lidars`, `radars` | declarations? | upsert the retained CPU sensor rig |
| `tick_index` | u32? | scene-state frame to apply before rendering (as in `render`) |
| `passes` | string[]? | subset of `rgb\|id\|depth\|semantic`; default `["rgb"]`. Selected per request: only these are copied off the GPU, and the instance-ID view renders only when `id`/`semantic` is requested. |
| `device_sensors` | string[]? | cameras whose open device streams are filled by this submission (see Device-resident mode below) |

Response: `{ok, sim_tick, frame, bundle_offset, bundle_len, frames[], device{}, server_ms}`.
`frame` is the identity of the single GPU submission every camera payload
was copied from: `{simTick, sceneRevision, rigRevision, generation}`
(`sceneRevision` bumps on every resident-scene mutation, `rigRevision` on
camera registration/removal/resize/re-mount, `generation` once per rendered
iteration). A response never mixes outputs of different submissions and
never reports a pass that was not rendered by that submission. `frames[]`
are FrameRecords with a mandatory `digest` (CRC32/IEEE of payload bytes,
8-char lowercase hex). `bundle_offset`/`bundle_len` locate the bundle record
for `bundle_at`-style consumers and PolicyStep frameBundle refs. `device`
maps each requested device sensor to `{stream, slot, generation}`.

Publish order per tick (single writer, deterministic): every camera in rig
registration order × requested passes in canonical order (rgb, id, depth,
semantic) → one `bundle` table record → meta-page latest-bundle pointer flip.

## Ring layout additions

All integers little-endian. Pre-existing: meta page `[0..8)` magic
`"UNISHRI1"`, `[8..16)` monotonic `write_cursor_total`; 128-byte record
headers; records never straddle the file end.

Meta page (new):

| bytes | field |
|---|---|
| `[16..24)` | bundle seqlock (0 = never published; odd = writer mid-flip) |
| `[24..32)` | latest bundle record offset (physical, header start) |
| `[32..40)` | latest bundle payload length |
| `[40..48)` | latest bundle `sim_tick` |

Bundle record: ordinary ring record with `sensor_id="__bundle__"`,
`pass="bundle"`, format tag `4`. Payload:

```
header (32 B): magic "SFBNDL01" u64 | sim_tick u64 | start_cursor u64
               | n_entries u32 | entries_crc u32 (CRC32 of entries region)
entry  (96 B): camera_id[48] | pass[16] | payload_offset u64 | payload_len u64
               | width u32 | height u32 | format u32 | digest u32
```

`payload_offset` points at PAYLOAD bytes (record header at `-128`).
`digest` is CRC32 (IEEE) of the payload — deterministic per rendered frame,
`zlib.crc32` / `crc32fast` / `@simforge-oss/render` `crc32()` all agree.
Payloads keep the wgpu 256-byte row alignment: `rowStride = payload_len /
height` for 4-byte-per-pixel formats.

## Atomicity contract (consumers never see torn bundles)

1. **Pointer**: seqlock read of `[16..48)` — retry while odd or changed.
2. **Table**: `entries_crc` covers the whole entries region; a mid-overwrite
   bundle record fails CRC (or magic) and is rejected.
3. **Payloads**: per-frame `digest` verify (QA / non-hot paths).
4. **Liveness (hot loop)**: `write_cursor_total - start_cursor <=
   capacity - 4096` — cheap check that the writer has not lapped the ring
   since this bundle's first frame. Size the ring for ≥2 bundles (the service
   also refuses to publish a bundle larger than the ring).

## Consumer APIs

**Python (policy runner, zero-copy)** — `renderer/service/python/simforge_native`:

```python
from simforge_native import BundleRingReader, NativeRenderClient

# Pull mode (separate process, shm only):
reader = BundleRingReader("/dev/shm/<ring>")
for bundle in reader.iter_bundles():          # yields each new sim_tick
    obs = bundle.views()                      # {cam: {pass: np view}} zero-copy
    ...                                       # (H,W,4) u8 rgba8 / (H,W) f32 depth
    if not bundle.still_valid(): continue     # writer lapped mid-use
reader.latest(verify=True)                    # digest-verified snapshot
reader.bundle_at(offset, length)              # from a frameBundle ref

# Push mode (same process as the RPC driver):
client = NativeRenderClient(socket_path)
obs, resp = client.step_bundle(sim_tick, cameras)   # cameras only on first call

# Device-resident mode (service built with `gpu-interop`, same GPU):
client.open_device_stream("front", ["rgb", "depth"], slots=3, wait_ms=50)
imported = client.import_device_stream("front")     # SCM_RIGHTS handles -> CUDA
resp = client.render_bundle(sim_tick, device_sensors=["front"], passes=[])
with client.lease_device_frame(imported, resp, "front") as lease:
    rgb = lease.plane("rgb").as_torch()             # GPU tensor on torch's current stream
    del rgb                                          # slot hands back once no view is alive
imported.close()                                     # False = deferred until last view dies
client.close_device_stream("front")
```

Device streams copy the camera's rendered planes GPU-locally into a leased
exportable slot of the same submission; the slot's ready signal is bound
to that submission. This is a GPU-local copy, not a copy-free alias of the
render target. Lifetimes (`simforge_native.gpu`):

- `lease.plane(name).as_torch()` registers torch's *current* stream on the
  renderer's device (ready wait, and that stream joins the release); any
  other device raises `GpuInteropError` (no-copy API). `lease.wait_on(stream)`
  registers an extra consumer stream explicitly.
- `lease.release()` / `with` exit *requests* hand-back and returns `bool`.
  The release semaphore is signalled only after every `PlaneView`/tensor
  built from the lease has been dropped, so a retained tensor keeps the
  slot outstanding on the renderer (bounded backpressure holds: the next
  bundle waits up to `wait_ms`, then fails explicitly) and its memory valid.
  `lease.release_requested`, `lease.released`, `lease.live_views` report the state.
- `ImportedStream.close()` returns `True` when the imports were destroyed
  immediately, `False` when teardown is deferred until the last view/lease
  dies (then automatic; `stream.closed`/`stream.torn_down`). Teardown waits
  on per-lease completion events, never a device-wide sync.
- The renderer's `close_device_stream(grace_ms)` counts consumer leases still
  outstanding after the grace; their imported memory stays valid through the
  consumer's own import.

Zero-copy views pin the mmap: drop views before `reader.close()`.
`verify=True` raises `TornBundleError` on any digest/liveness failure.

The package depends on `msgpack` (wire codec) and `numpy`. The in-process
`EmbeddedRenderer` resolves `libsimforge_render.so` from `library=`, then
`$SIMFORGE_RENDER_LIB`, then `$SIMFORGE_NATIVE_RUNTIME_ROOT/lib/` (default
`${XDG_DATA_HOME:-~/.local/share}/simforge/native-runtime`), then the loader
path; it never probes a source tree.

The renderer's star/Moon plates (`starmap_2020_8k.skytex`,
`moon_lroc_4k.skytex`, gitignored derivatives built by
`renderer/tools/prepare_sky_assets.py` from the NASA sources in
`renderer/render-core/assets/sky/SOURCES.json`) resolve from
`$SIMFORGE_SKY_ASSETS`, then `$SIMFORGE_NATIVE_RUNTIME_ROOT/share/sky`, then
the source checkout's `renderer/render-core/assets/sky`. The chosen directory
must hold `SOURCES.json`; each plate's size and sha256 are checked against it
and any mismatch or absence fails `SceneApp` construction (service prewarm,
`EmbeddedRenderer(...)`, job) instead of rendering a starless sky.

**Runner workload `simforge.render-bundle/v1`** — `python -m simforge_native
job --params P --out-dir D [--resume C]` renders a scene-state stream through
`EmbeddedRenderer` following the provider job protocol (JSONL `progress` /
`checkpoint` / `done{artifacts}` on stdout, `error` on stderr, exit
0/1/2/130). Outputs: `frames/<sensorId>/<pass>/tick-<06d>.{png,bin,ply,csv}`,
`bundles.jsonl` (per-tick `FrameIdentity` + records), `results.json`,
`checkpoint/checkpoint-<n>.json`. `python -m simforge_native capabilities`
prints protocol, passes, the resolved library (path, sha256) and whether it
was built with `gpu-interop` (`simforge_render_gpu_interop()`).

**TypeScript (studio worker, copying)** — `@simforge-oss/render/native`:

```ts
import { ShmBundleReader } from '@simforge-oss/render/native';
const reader = new ShmBundleReader(shmPath);
const bundle = reader.latestNew();   // null until a NEW sim_tick appears
// bundle.entries[i]: {cameraId, pass, byteOffset, byteLength, width, height,
//                     format, digest}; bundle.payloads[i]: verified Buffer copy
```

Every payload is copied and digest-verified at read time; `TornBundleError`
means the writer lapped mid-read — retry on the next poll.

**Rust (in-repo)** — `service::shm::{read_bundle_pointer, decode_bundle,
read_record_header}` mirror the same protocol for tests and future native
consumers.

## PolicyStep frameBundle mapping

`FrameBundleRef {shmName, simTick, cameras[]}` (locked with PolicyStep
2026-08-24): `shmName` = ring path from `hello.shm.path`; per camera
`{id, digest, byteOffset, byteLength, width, height, format}` map 1:1 from
the `render_bundle` response frames (`digest` hex, `byteOffset = offset+128`).

## Tests & bench

- Rust: `cargo test -p service shm::` — bundle roundtrip, torn-table CRC,
  seqlock pointer + digest validation, wraparound expiry, no-straddle.
- Python: `python3 -m pytest tests/test_bundles.py` (from
  `renderer/service/python`) against `renderer/service/testdata/
  bundle-ring.shm.gz`, a ring recorded by the real service.
- TS: `npx vitest run src/native/shm-bundles.test.ts` (packages/render),
  same recorded ring.
- Bench: `renderer/service/python/bench_bundles.py` — sustained 10 Hz
  render+publish+consume latency; results in the lane report.
