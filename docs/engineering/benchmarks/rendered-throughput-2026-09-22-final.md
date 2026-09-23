# Native camera-profile throughput

Measured 2026-09-22T10:53:58.761Z; git `9dfd2baafe2e2265b21459d122543a9e91d57a8f`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs; Linux 7.0.0-31-generic. GPU: NVIDIA GeForce RTX 5080, 16303 MiB, 595.84, 00000000:02:00.0.

One tick is a complete bundle of every camera in the named rig at the registry resolution, not one image. The kernel Episode camera channel drives the same native service as the bench, without a model or the bench’s extra HUD camera. Episode stepping, trace, camera RPC, GPU readback and zero-copy FrameRef access are timed; PNG/HUD/video encoding and startup are not.

Median of 3 windows ≥5 s, each after 20 rendered warm-up ticks.

| Profile | Native resolutions | Median ticks/s | Window rates |
|---|---|---:|---|
| alpamayo-2cam | 512×384, 512×384 | 13.01 | 13.01, 12.85, 13.27 |
| qwen-drive-3cam | 512×384, 512×384, 512×384 | 8.78 | 9.43, 8.78, 8.45 |
| auto-e2e-6view | 512×384, 512×384, 512×384, 512×384, 512×384, 512×384 | 5.30 | 5.62, 5.22, 5.30 |

Gate: **PASS**; alpamayo-2cam must sustain ≥5 ticks/s.

Raw counts, timings, frame hashes, renderer identity and mesh digests: [rendered-throughput-2026-09-22-final.json](rendered-throughput-2026-09-22-final.json).
