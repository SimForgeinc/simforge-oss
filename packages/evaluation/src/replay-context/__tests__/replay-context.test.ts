import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadEvalClip, reconstructionRefusal } from '../clip.js';
import { createEnvelopeMonitor, measureDynamicsConsistency, trajectoryGates } from '../envelope.js';
import { gateG2 } from '../gates.js';
import { classifyEpisodeOutcome, partitionOutcomes } from '../outcome.js';
import { loadReplayContext, tryLoadReplayContext } from '../qualify.js';
import { ReplayContextSchema, type GateVerdict } from '../schema.js';

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
