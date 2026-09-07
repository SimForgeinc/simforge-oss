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
 * `BUILD_VERIFIED` is false and must stay false until every item in `BUILD_EVIDENCE_OWED` has
 * been produced on the image that will run the work. A pin states which source is used; it is
 * never a claim that the source builds or runs.
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
  pin: 'ffmpeg-static b6.1.1',
  /** Reused from the desktop's own lock rather than re-pinned here, so both hosts decode identically. */
  source: 'studio/desktop/tools.lock.json',
  resolvedAtRuntimeBy: 'SIMFORGE_FFMPEG / SIMFORGE_FFPROBE, the staged desktop runtime manifest, or PATH',
  licenseObligation:
    'GPL applies to these executables only; they are separate programs the host spawns, never linked. '
    + 'Redistributing them inside a worker image pushed to a third-party registry is a corresponding-source '
    + 'obligation and is a recorded review gate, not an assertion.',
} as const;

export const NCORE = {
  package: 'nvidia-ncore',
  status: 'optional',
  usedBy: 'the NCore v4 reconstruction path required by f-theta camera rigs',
  /** Explicit capability restriction, never a silent remap onto a COLMAP camera model. */
  whenAbsent: 'f-theta rigs are refused with a capability restriction naming this package',
} as const;

export const BUILD_VERIFIED = false;

export const BUILD_EVIDENCE_OWED: readonly string[] = [
  "3DGRUT tracer compiled successfully against the image's torch/CUDA at the pinned commit",
  'kaolin imports and reports the expected version against that same torch build',
  'one render of a known scene through simforge-oss-splat, digest recorded',
  'one reconstruction of a calibrated sequence completing training and exporting a NuRec .usdz',
];
