# Native camera-profile throughput

Measured 2026-09-22T09:41:20.287Z; git `76f5f76002d83f7bbded9e29ec1899872b876d95`; runner `gpu-rtx5080`.

Hardware: Intel(R) Core(TM) Ultra 9 285K; 24 logical CPUs; Linux 7.0.0-31-generic. GPU: NVIDIA GeForce RTX 5080, 16303 MiB, 595.84, 00000000:02:00.0.

One tick is a complete bundle of every camera in the named rig at the registry resolution, not one image. The shared drive scene/camera/service path runs without a model or the bench’s extra HUD camera. Native stepping, scene RPC and all RGB readback are timed; PNG/HUD/video encoding and startup are not.

Median of 3 windows ≥5 s, each after 20 rendered warm-up ticks.

| Profile | Native resolutions | Median ticks/s | Window rates |
|---|---|---:|---|
| alpamayo-2cam | 512×384, 512×384 | 13.56 | 11.55, 13.56, 14.15 |
| qwen-drive-3cam | 512×384, 512×384, 512×384 | 8.12 | 7.74, 8.17, 8.12 |
| auto-e2e-6view | 512×384, 512×384, 512×384, 512×384, 512×384, 512×384 | 5.10 | 5.27, 5.10, 5.05 |

Gate: **PASS**; alpamayo-2cam must sustain ≥5 ticks/s.

Raw counts, timings, frame hashes, renderer identity and mesh digests: [rendered-throughput-2026-09-22.json](rendered-throughput-2026-09-22.json).
