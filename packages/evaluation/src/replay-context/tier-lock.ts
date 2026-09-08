/**
 * Pinned external prerequisites for the reconstruction and render tier.
 *
 * These are the versions the worker image provisions and the versions every measured gate
 * number is attributed to. They live in TypeScript rather than a JSON sidecar so there is
 * exactly one source of truth: `preflightReconstruction` compares a resolved checkout against
 * `THREEDGRUT.commit`, the reconstruction provenance records it, and the worker image build
 * pins the same value — a second copy in a data file could drift from all three.
 *
 * Provisioning targets product-owned images and storage only. No research host, allocation,
 * frozen set or existing research process is used to satisfy any of these.
 *
 * `BUILD_VERIFIED` is false and must stay false until every item in `BUILD_EVIDENCE` has been
 * produced on the image that will run the work. A pin states which source is used; it is never
 * a claim that the source builds or runs.
 */

export const THREEDGRUT = {
  repository: 'https://github.com/nv-tlabs/3dgrut',
  commit: 'a37ef721012dea0f29c0fcfff2d525023b4e854a',
  commitResolvedAt: '2026-09-07',
  /**
   * Resolved from the GitHub API (refs/heads/main, committed 2026-07-08). This is the same
   * revision `renderer/splat/PROVENANCE.json` documents the NuRec splat port against
   * (`upstreamDocumentedCommit: "a37ef72"`), so the reconstruction tier and the shipped
   * renderer agree on one upstream revision instead of two.
   */
  commitSource: 'GitHub API refs/heads/main; matches renderer/splat/PROVENANCE.json upstreamDocumentedCommit',
  license: 'Apache-2.0',
  clone: 'git clone --recursive (submodules are required for the tracer)',
  provides: ['train.py', 'threedgrut.export.scripts.export_usd', 'threedgut_tracer', 'configs/apps'],
  resolvedAtRuntimeBy: 'THREEDGRUT_ROOT, or an importable threedgrut package',
} as const;

export const KAOLIN = {
  package: 'kaolin',
  version: '0.18.0',
  commit: '06ffb7d955ca26b608c60a9e862327c56b226921',
  source: "NVIDIA Kaolin, installed from NVIDIA's index for the image's exact torch/CUDA build",
  /** The PyPI project of the same name is unrelated; installing it imports fine and renders nonsense. */
  warning: "the PyPI project named 'kaolin' is a different project and is never a substitute",
  license: 'Apache-2.0',
} as const;

export const TORCH = {
  requirement: '>=2.8, CUDA build matching the host driver',
  note: "3DGRUT's tracer is compiled against this build, so torch and the tracer cannot be resolved independently.",
} as const;

export const ENCODER = {
  component: 'ffmpeg/ffprobe',
  /** Built from Git-pinned source by the desktop stage; not a prebuilt download. */
  pin: 'FFmpeg n7.1.5 + libx264, built from pinned source',
  /** Reused from the desktop's own lock rather than re-pinned here, so both hosts decode identically. */
  source: 'studio/desktop/encoders.lock.json',
  resolvedAtRuntimeBy: 'SIMFORGE_FFMPEG / SIMFORGE_FFPROBE, the staged desktop runtime manifest, or PATH',
  /**
   * Built `--disable-autodetect` and `--disable-network`: internal decoders (H.264, HEVC, VP9,
   * MJPEG, ProRes, AV1) are available for clip extraction, but the binary cannot be pointed at
   * a URL. Extraction therefore only ever takes a local file.
   */
  buildClosure: '--disable-autodetect, --disable-network; internal decoders at defaults',
  licenseObligation:
    'GPL applies to these executables only; they are separate programs the host spawns, never linked. '
    + 'The obligation is discharged by shipping the complete corresponding source as a release asset.',
} as const;

export const NCORE = {
  package: 'nvidia-ncore',
  status: 'optional',
  usedBy: 'the NCore v4 reconstruction path required by f-theta camera rigs',
  /** Explicit capability restriction, never a silent remap onto a COLMAP camera model. */
  whenAbsent: 'f-theta rigs are refused with a capability restriction naming this package',
} as const;

/**
 * Still false: three of the four owed items are produced, the fourth is not.
 *
 * A tier is "build verified" when everything it is used for has been exercised on it, and the
 * reconstruction path has not been. Flipping this on three quarters of the evidence would make
 * the flag mean "mostly".
 */
export const BUILD_VERIFIED = false;

export interface BuildEvidenceItem {
  readonly item: string;
  readonly produced: boolean;
  readonly evidence?: string;
}

/**
 * Evidence produced on this host, 2026-09-08, against the pins above.
 *
 * Recorded here rather than in a report so the flag and its justification cannot drift apart.
 */
export const BUILD_EVIDENCE: readonly BuildEvidenceItem[] = [
  {
    item: "3DGRUT tracer compiled successfully against the image's torch/CUDA at the pinned commit",
    produced: true,
    evidence:
      'installed at the pinned commit with submodules; threedgut_tracer imports, tiny-cuda-nn ready, '
      + 'PPISP 1.2.1, Fused-SSIM ready, against torch 2.8.0+cu128 (upstream lock) and CUDA 12.8.1',
  },
  {
    item: 'kaolin imports and reports the expected version against that same torch build',
    produced: true,
    evidence: 'kaolin 0.18.0 imports, matching the pin above',
  },
  {
    item: 'one render of a known scene through simforge-oss-splat, digest recorded',
    produced: true,
    evidence:
      'scene 007a5809 (package sha256 36665d69…, verified against its pinned digest) rendered at four '
      + 'cameras over five probes; G1 19.67 dB worst camera, G2 coverage 0.84/1.59/2.15/6.80% by offset',
  },
  {
    item: 'one reconstruction of a calibrated sequence completing training and exporting a NuRec .usdz',
    produced: true,
    evidence:
      'product-owned 24-view pinhole capture (make_calibration_capture.py) -> COLMAP dataset -> '
      + '3DGUT train.py apps/colmap_3dgut.yaml, 3000 iterations, test PSNR 36.10 / SSIM 0.981 -> '
      + 'export_last_nurec.usdz (5,246,764 B, 1 camera from 21 frames)',
  },
];

/**
 * Why `BUILD_VERIFIED` is still false with every item produced.
 *
 * The flag is a claim about **the image that will run the work**, and this evidence comes from
 * the dev host. The worker image is built by the compute owner from the same pins; when the
 * four items are reproduced there, the flag flips for that image. Reading host evidence as
 * image verification is exactly the substitution the flag exists to prevent.
 */
export const HOST_EVIDENCE_DATE = '2026-09-08';
