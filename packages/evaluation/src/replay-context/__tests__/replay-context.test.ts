import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadEvalClip, reconstructionRefusal, sequenceDigest } from '../clip.js';
import { createEnvelopeMonitor, measureDynamicsConsistency, trajectoryGates } from '../envelope.js';
import { gateG2 } from '../gates.js';
import { classifyEpisodeOutcome, partitionOutcomes } from '../outcome.js';
import { DrivableAreaSchema, classifyPoint, footprintContainment, pointIsDrivable, scoreOffRoad, type DrivableArea } from '../drivable.js';
import { loadReplayContext, tryLoadReplayContext } from '../qualify.js';
import { ReplayContextSchema, servesProfile, type GateVerdict } from '../schema.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('clip admission', () => {
  it('refuses a video-only clip for driving inference and names every missing input', async () => {
    const admission = await loadEvalClip(fixture('video-only-clip'));

    expect(admission.openLoopInference).toBe(false);
    expect(admission.openLoopScored).toBe(false);
    expect(admission.reconstructionReady).toBe(false);
    const paths = admission.refusal?.missing.map((field) => field.path);
    expect(paths).toEqual(['cameras', 'ego']);
    // The refusal has to stay actionable: it says what the clip can still do.
    expect(admission.refusal?.alternatives.join(' ')).toContain('vqa');
    expect(admission.refusal?.alternatives.join(' ')).toContain('no driving score');
  });

  it('admits a calibrated clip open-loop but refuses reconstruction without seed geometry', async () => {
    const admission = await loadEvalClip(fixture('calibrated-clip-no-geometry'));

    expect(admission.openLoopInference).toBe(true);
    expect(admission.refusal).toBeUndefined();
    // No recorded future: inference is allowed, scoring is not.
    expect(admission.openLoopScored).toBe(false);

    const refusal = reconstructionRefusal(admission);
    expect(refusal?.missing.map((field) => field.path)).toEqual(['pointCloud']);
    expect(refusal?.message).toContain('random noise');
  });

  it('reports the model families a clip can serve from its camera set alone', async () => {
    const admission = await loadEvalClip(fixture('calibrated-clip-no-geometry'));
    const byFamily = Object.fromEntries(admission.families.map((verdict) => [verdict.family, verdict]));

    // One front-wide camera (index 1): enough for the variable-camera family, not for the fixed ones.
    expect(byFamily['alpamayo-1.5']?.canServe).toBe(true);
    expect(byFamily['alpamayo-1']?.canServe).toBe(false);
    expect(byFamily['alpamayo-1']?.missingCameras).toEqual([0, 2, 6]);
    expect(byFamily['alpamayo-2-super']?.canServe).toBe(false);
  });
});

describe('validity envelope', () => {
  it('truncates outside the measured envelope and stays inside within it', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    const monitor = createEnvelopeMonitor(bundle);
    const tUs = bundle.ego.originUs + 1_000_000;

    const inside = monitor.check({ tUs, x: 10, y: 0.5, headingRad: 0 });
    expect(inside.inside).toBe(true);
    expect(inside.term).toBeUndefined();
    expect(inside.deviation.lateralM).toBeCloseTo(0.5, 6);

    const outside = monitor.check({ tUs, x: 10, y: 2, headingRad: 0 });
    expect(outside.inside).toBe(false);
    expect(outside.term).toBe('envelope_exceeded');
    expect(outside.breached).toContain('lateral');
    expect(outside.deviation.lateralM).toBeCloseTo(2, 6);
  });

  it('treats running past the recorded window as leaving the envelope', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    const monitor = createEnvelopeMonitor(bundle);

    const beyond = monitor.check({ tUs: bundle.ego.endUs + 1_000_000, x: 30, y: 0, headingRad: 0 });
    expect(beyond.inside).toBe(false);
    expect(beyond.breached).toContain('time-support');
  });

  it('measures lateral deviation against the path, not the nearest recorded sample', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    const monitor = createEnvelopeMonitor(bundle);
    // Exactly between two 1 m-apart recorded poses, dead on the path: vertex snapping would
    // report ~0.5 m of phantom error here and truncate a valid episode.
    const between = monitor.check({ tUs: bundle.ego.originUs + 50_000, x: 0.5, y: 0, headingRad: 0 });

    expect(between.deviation.lateralM).toBeCloseTo(0, 6);
    expect(between.inside).toBe(true);
  });
});

describe('gate semantics', () => {
  it('stops the envelope at the first failing offset instead of taking the largest pass', () => {
    const result = gateG2(
      [
        { lateralM: 0.5, headingRad: 0, holeFraction: 0.001, worstCamera: 'front' },
        { lateralM: 1.0, headingRad: 0, holeFraction: 0.5, worstCamera: 'front' },
        { lateralM: 1.5, headingRad: 0, holeFraction: 0.001, worstCamera: 'front' },
      ],
      0.1,
    );

    expect(result.envelope.lateralM).toBe(0.5);
    expect(result.gate.passed).toBe(true);
  });

  it('yields a zero-width envelope when even the smallest offset fails', () => {
    const result = gateG2([{ lateralM: 0.5, headingRad: 0, holeFraction: 0.9, worstCamera: 'front' }], 0.1);

    expect(result.envelope.lateralM).toBe(0);
    expect(result.gate.passed).toBe(false);
  });

  it('flags recorded actors that intersect the recorded ego path', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    expect(measureDynamicsConsistency(bundle).egoPathIntersections).toBe(0);
    expect(trajectoryGates(bundle).G4.passed).toBe(true);

    // Move the lead actor onto the ego's own recorded path: tracks and ego now disagree
    // about the world, which G4 exists to catch.
    const collided = {
      ...bundle,
      dynamics: {
        ...bundle.dynamics,
        tracks: bundle.dynamics.tracks.map((track) => ({
          ...track,
          samples: track.samples.map((sample) => ({ ...sample, x: sample.x - 25, y: 0 })),
        })),
      },
    };
    expect(measureDynamicsConsistency(collided).egoPathIntersections).toBeGreaterThan(0);
    expect(trajectoryGates(collided).G4.passed).toBe(false);
  });
});

describe('bundle invariants', () => {
  it('rejects a bundle that claims qualification while a gate failed', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    const gates = trajectoryGates(bundle);
    const pass = (id: 'G1' | 'G2' | 'G5'): GateVerdict => ({
      id,
      name: id,
      passed: true,
      measured: 1,
      threshold: 0,
      direction: 'at-least',
      unit: 'unit',
      rationale: 'fixture',
    });
    // All five gates are recorded, so the only defect is the one failing verdict.
    const claimed = {
      ...bundle,
      source: { ...bundle.source, kind: 'nurec' as const },
      validity: {
        ...bundle.validity,
        qualified: true,
        gates: { G1: pass('G1'), G2: pass('G2'), G3: gates.G3, G5: pass('G5'), G4: { ...gates.G4, passed: false } },
      },
    };

    const parsed = ReplayContextSchema.safeParse(claimed);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('gate G4 failed');
  });

  it('never lets a synthetic fixture be qualified for evaluation', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    expect(bundle.source.kind).toBe('synthetic-fixture');
    expect(bundle.validity.qualified).toBe(false);

    const forced = { ...bundle, validity: { ...bundle.validity, qualified: true } };
    const parsed = ReplayContextSchema.safeParse(forced);
    expect(parsed.success).toBe(false);
  });
});

describe('episode outcomes', () => {
  it('never lets a truncated episode count as a success or enter a scored aggregate', () => {
    const truncated = classifyEpisodeOutcome({
      episodeId: 'ep-1',
      complete: false,
      truncation: 'envelope_exceeded',
      breached: ['lateral'],
      atStep: 83,
    });

    expect(truncated.succeeded).toBe(false);
    expect(truncated.aggregateEligible).toBe(false);
    expect(truncated.diagnosticsOnly).toBe(true);
    expect(truncated.status).toBe('truncated');
    expect(truncated.reason).toContain('step 83');
    expect(truncated.reason).toContain('lateral');
  });

  it('partitions a run so held-out episodes are counted, not dropped', () => {
    const outcomes = [
      classifyEpisodeOutcome({ episodeId: 'a', complete: true }),
      classifyEpisodeOutcome({ episodeId: 'b', complete: false, truncation: 'envelope_exceeded' }),
      classifyEpisodeOutcome({ episodeId: 'c', complete: false, truncation: 'invalid_scene' }),
    ];
    const partition = partitionOutcomes(outcomes);

    expect(partition.aggregate.map((outcome) => outcome.episodeId)).toEqual(['a']);
    expect(partition.diagnostic.map((outcome) => outcome.episodeId)).toEqual(['b', 'c']);
    expect(partition.counts).toEqual({ total: 3, complete: 1, truncated: 1, invalid: 1 });
  });
});

describe('bundle loading', () => {
  it('reports a malformed bundle as a value with the offending field paths', async () => {
    const result = await tryLoadReplayContext(fixture('video-only-clip/clip.json'));

    // An eval-clip is well-formed JSON but is not a replay context.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('replay_context_invalid');
    expect(result.fields.length).toBeGreaterThan(0);
  });

  it('distinguishes an absent bundle from a malformed one', async () => {
    const result = await tryLoadReplayContext(fixture('straight-envelope/does-not-exist.json'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('replay_context_missing');
  });

  it('still throws from the loading variant, carrying the same detail', async () => {
    await expect(loadReplayContext(fixture('video-only-clip/clip.json'))).rejects.toThrow(/replay-context/);
  });
});

describe('G4 against real package shapes', () => {
  it('does not fail a scene for publishing reference frames instead of a timeline', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    // The NuRec AV releases ship one reference frame per camera. Measuring track alignment
    // against those instants failed a genuine release by ~20 s; the gate must not care.
    const referenceOnly = {
      ...bundle,
      cameras: bundle.cameras.map((camera) => ({
        ...camera,
        timing: { kind: 'reference-frames' as const, timestampsUs: [bundle.ego.originUs + 1_000], shutterUs: 30_000 },
      })),
    };

    const measured = measureDynamicsConsistency(referenceOnly);
    expect(measured.framesOutsideWindow).toBe(0);
    expect(trajectoryGates(referenceOnly).G4.passed).toBe(true);
  });

  it('fails a scene whose actor tracks are too sparse to interpolate', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    const sparse = {
      ...bundle,
      dynamics: {
        ...bundle.dynamics,
        tracks: bundle.dynamics.tracks.map((track) => ({
          ...track,
          // Keep the endpoints only: a 2 s gap cannot be interpolated into a faithful pose.
          samples: [track.samples[0]!, track.samples[track.samples.length - 1]!],
        })),
      },
    };

    expect(measureDynamicsConsistency(sparse).maxTrackSampleGapUs).toBeGreaterThan(200_000);
    expect(trajectoryGates(sparse).G4.passed).toBe(false);
  });

  it('fails a scene whose published frames fall outside the recorded window', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    const strayFrame = {
      ...bundle,
      cameras: bundle.cameras.map((camera) => ({
        ...camera,
        timing: { kind: 'reference-frames' as const, timestampsUs: [bundle.ego.endUs + 5_000_000], shutterUs: 0 },
      })),
    };

    expect(measureDynamicsConsistency(strayFrame).framesOutsideWindow).toBe(1);
    expect(trajectoryGates(strayFrame).G4.passed).toBe(false);
  });
});

describe('per-profile qualification', () => {
  it('refuses a rig that needs a camera the scene was not qualified for', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    // The fixture declares camera 1 only; pretend it passed for that one camera.
    const qualifiedForWide = {
      ...bundle,
      source: { ...bundle.source, kind: 'nurec' as const },
      validity: { ...bundle.validity, qualified: true, profileCameraIds: [1] },
    };

    expect(servesProfile(qualifiedForWide, [1]).ok).toBe(true);
    // alpamayo-2cam needs [1, 6]; camera 6 was never qualified here.
    const verdict = servesProfile(qualifiedForWide, [1, 6]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('6');
  });

  it('refuses any rig on an unqualified scene', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    expect(bundle.validity.qualified).toBe(false);
    expect(servesProfile(bundle, [1]).ok).toBe(false);
  });

  it('rejects a bundle qualified over a camera it does not have, or over none', async () => {
    const bundle = await loadReplayContext(fixture('straight-envelope'));
    const base = { ...bundle, source: { ...bundle.source, kind: 'nurec' as const } };

    const phantomCamera = { ...base, validity: { ...base.validity, profileCameraIds: [6] } };
    expect(ReplayContextSchema.safeParse(phantomCamera).success).toBe(false);

    const noProfile = { ...base, validity: { ...base.validity, qualified: true, profileCameraIds: [] } };
    const parsed = ReplayContextSchema.safeParse(noProfile);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('camera set');
  });
});

describe('image-sequence integrity', () => {
  it('digests a sequence as a whole, so a changed or added frame is detected', async () => {
    const { cp, mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');

    const scratch = await mkdtemp(nodePath.join(tmpdir(), 'sf-seq-'));
    try {
      const source = fixture('video-only-clip/frames/camera_front_wide_120fov');
      const copy = nodePath.join(scratch, 'frames');
      await cp(source, copy, { recursive: true });
      const original = await sequenceDigest(copy);
      expect(original).toMatch(/^[a-f0-9]{64}$/);
      // Same bytes, same digest.
      expect(await sequenceDigest(copy)).toBe(original);

      // An added frame changes it — a per-file check on a directory path could not see this.
      await writeFile(nodePath.join(copy, '0000000001.png'), Buffer.from([1, 2, 3]));
      expect(await sequenceDigest(copy)).not.toBe(original);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('drivable-area containment (lane-union geometry, off-road v2)', () => {
  // A 20 x 10 rectangle of road with a 4 x 2 island cut out of its middle.
  const area: DrivableArea = {
    source: 'clipgt-lane-union',
    geometry: 'polygons',
    frame: 'test-frame',
    confidence: 'authoritative',
    timeSupportUs: null,
    boundaries: [],
    polygons: [
      { id: 'road', kind: 'drivable', ring: [[0, 0], [20, 0], [20, 10], [0, 10]] },
      { id: 'island', kind: 'hole', ring: [[8, 4], [12, 4], [12, 6], [8, 6]] },
    ],
    coverage: { boundsMinXY: [0, 0], boundsMaxXY: [20, 10] },
  };
  const car = { lengthM: 4, widthM: 2 };

  it('accepts a footprint fully inside the drivable surface', () => {
    const result = footprintContainment(area, { x: 4, y: 2, headingRad: 0, ...car });
    expect(result.inside).toBe(true);
    expect(result.cornersOutside).toBe(0);
    expect(result.worstOutsideM).toBe(0);
  });

  it('rejects a footprint fully outside, and reports how far out', () => {
    const result = footprintContainment(area, { x: 30, y: 5, headingRad: 0, ...car });
    expect(result.inside).toBe(false);
    expect(result.cornersOutside).toBe(4);
    // Nearest corner of the box is 8 m past the x=20 edge.
    expect(result.worstOutsideM).toBeGreaterThan(9);
  });

  it('treats a hole as undrivable even though it lies inside the road', () => {
    // Centre of the island: inside the road ring, inside the hole.
    expect(pointIsDrivable(area, 10, 5)).toBe(false);
    expect(pointIsDrivable(area, 10, 2)).toBe(true);
    expect(footprintContainment(area, { x: 10, y: 5, headingRad: 0, ...car }).inside).toBe(false);
  });

  it('catches a footprint straddling the boundary that a centre test would pass', () => {
    // Centre is on the road; the box overhangs the y=10 edge by 1 m.
    expect(pointIsDrivable(area, 5, 9.5)).toBe(true);
    const result = footprintContainment(area, { x: 5, y: 9.5, headingRad: 0, ...car });
    expect(result.inside).toBe(false);
    expect(result.cornersOutside).toBe(2);
    expect(result.worstOutsideM).toBeCloseTo(0.5, 6);
  });

  it('accounts for orientation: the same centre passes or fails with heading', () => {
    // Lengthwise along a narrow strip fits; rotated 90 degrees it does not.
    const narrow: DrivableArea = { ...area, polygons: [{ id: 'strip', kind: 'drivable', ring: [[0, 0], [20, 0], [20, 3], [0, 3]] }] };
    expect(footprintContainment(narrow, { x: 10, y: 1.5, headingRad: 0, ...car }).inside).toBe(true);
    expect(footprintContainment(narrow, { x: 10, y: 1.5, headingRad: Math.PI / 2, ...car }).inside).toBe(false);
  });

  it('scores a pose sequence and stamps the metric version', () => {
    const poses = [
      { tUs: 0, x: 4, y: 2, headingRad: 0 },
      { tUs: 100_000, x: 10, y: 5, headingRad: 0 },  // on the island
      { tUs: 200_000, x: 16, y: 2, headingRad: 0 },
    ];
    const result = scoreOffRoad(area, poses, car);
    expect(result.metric).toBe('simforge.offroad/v2');
    expect(result.samples).toBe(3);
    expect(result.events.map((event) => event.tUs)).toEqual([100_000]);
  });
});

describe('drivable-area classification (road-boundary geometry, off-road v3)', () => {
  // A corridor: two edges running +x, the road between them. The left edge (y = 10) is walked
  // in -x so its drivable side is also the corridor; both terminate at a CUT, which is how the
  // real data ends — labelling stops, the road does not.
  const area: DrivableArea = {
    source: 'clipgt-road-boundary',
    geometry: 'oriented-boundaries',
    frame: 'test-frame',
    confidence: 'authoritative',
    timeSupportUs: null,
    boundaries: [
      { id: 'right-edge', points: [[0, 0], [100, 0]], drivableSide: 'left', cutStart: true, cutEnd: true },
      { id: 'left-edge', points: [[100, 10], [0, 10]], drivableSide: 'left', cutStart: true, cutEnd: true },
    ],
    polygons: [{ id: 'median', kind: 'hole', ring: [[40, 4], [60, 4], [60, 6], [40, 6]] }],
    coverage: { boundsMinXY: [0, 0], boundsMaxXY: [100, 10] },
  };
  const car = { lengthM: 4, widthM: 2 };

  it('puts a point on the stated drivable side of the nearest edge on the road', () => {
    expect(classifyPoint(area, 20, 2).verdict).toBe('drivable');
    expect(classifyPoint(area, 20, 8).verdict).toBe('drivable');
  });

  it('calls the far side of an edge off-road, and says how far out', () => {
    const beyond = classifyPoint(area, 20, -3);
    expect(beyond.verdict).toBe('off-road');
    expect(beyond.distanceM).toBeCloseTo(3, 6);
  });

  it('reports unavailable past a CUT terminus instead of inventing an excursion', () => {
    // Beyond x = 100 the nearest feature is the cut end of both edges: labelling stopped there.
    // This is the whole reason the boundary source can be used without synthesising closure.
    expect(classifyPoint(area, 130, 5).verdict).toBe('unavailable');
    // And it does not leak inward: well inside the labelled span the answer is still decided.
    expect(classifyPoint(area, 50, 1).verdict).toBe('drivable');
  });

  it('keeps an island exclusion undrivable inside the corridor', () => {
    expect(classifyPoint(area, 50, 5).verdict).toBe('off-road');
  });

  it('counts an unavailable sample separately from a clean one and never as an event', () => {
    const poses = [
      { tUs: 0, x: 20, y: 2, headingRad: 0 },        // clean
      { tUs: 100_000, x: 20, y: -3, headingRad: 0 }, // genuinely off the road
      { tUs: 200_000, x: 130, y: 5, headingRad: 0 }, // past the cut: unknown
    ];
    const result = scoreOffRoad(area, poses, car);
    expect(result.metric).toBe('simforge.offroad/v3');
    expect(result.source).toBe('clipgt-road-boundary');
    expect(result.samples).toBe(3);
    expect(result.assessed).toBe(2);
    expect(result.unavailable).toBe(1);
    expect(result.events.map((event) => event.tUs)).toEqual([100_000]);
  });

  it('distinguishes assessed-and-clean from nothing-assessed', () => {
    const clean = scoreOffRoad(area, [{ tUs: 0, x: 20, y: 2, headingRad: 0 }], car);
    expect(clean.worstOutsideM).toBe(0);
    const none = scoreOffRoad(area, [{ tUs: 0, x: 130, y: 5, headingRad: 0 }], car);
    expect(none.worstOutsideM).toBeNull();
    expect(none.assessed).toBe(0);
  });

  it('refuses geometry that declares a kind it does not carry', () => {
    const parsed = DrivableAreaSchema.safeParse({ ...area, boundaries: [] });
    expect(parsed.success).toBe(false);
  });
});
