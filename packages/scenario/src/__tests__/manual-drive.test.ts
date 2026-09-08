import { describe, expect, it } from 'vitest';

import {
  MANUAL_DRIVE_MAX_SAMPLES,
  validateManualDriveRecording,
  type ManualDriveRecording,
  type ManualDriveSample,
} from '../schema/v2/manual-drive.js';
import { parseTemplate } from '../serialize.js';
import { validateTemplate } from '../validate/index.js';
import type { ClauseResult, IssueCode } from '../validate/issues.js';
import { ltapTemplateInput } from './v2-fixtures.js';

const CLIP = 3;
const DT = 0.02;

function take(overrides: Partial<ManualDriveRecording> = {}): ManualDriveRecording {
  const ticks = Math.round(CLIP / DT);
  const samples: ManualDriveSample[] = [];
  for (let k = 0; k <= ticks; k += 1) {
    const timeS = Number((k * DT).toFixed(6));
    // stationary, then reversing, then forward — the recorded yaw stays put.
    const speedMps = timeS < 1 ? 0 : timeS < 2 ? -2 : 3;
    samples.push({ timeS, x: 10 - (timeS < 1 ? 0 : timeS - 1), y: 0, z: -4, headingRad: Math.PI, speedMps });
  }
  return { version: 1, clipSeconds: CLIP, samples, ...overrides };
}

function withManualDrive(options: {
  pinned?: boolean;
  static?: boolean;
  recording?: ManualDriveRecording;
  trigger?: { kind: 'at'; t: number };
  until?: { kind: 'at'; t: number } | null;
  extra?: readonly Record<string, unknown>[];
} = {}) {
  const base = ltapTemplateInput();
  return parseTemplate({
    ...base,
    anchor: {
      ...base.anchor,
      ...(options.pinned === false ? {} : { pin: { mapId: 'yale-street' } }),
    },
    roles: [{
      id: 'ego',
      kind: 'scene_absolute' as const,
      actor: { class: 'car' as const, static: options.static ?? false },
      pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 },
    }, base.roles![1]!],
    choreography: {
      clipSeconds: CLIP,
      interactions: [{
        id: 'take',
        actor: 'ego',
        trigger: options.trigger ?? { kind: 'at', t: 0 },
        ...(options.until === null ? {} : { until: options.until ?? { kind: 'at', t: CLIP } }),
        verb: 'route',
        target: { mode: 'manualDrive', recording: options.recording ?? take() },
      }, ...(options.extra ?? [])],
    },
    invariants: [],
  });
}

const codes = (issues: ClauseResult[]): IssueCode[] => issues.map((i) => i.code);

describe('validateManualDriveRecording', () => {
  it('accepts a full-clip take, including a two-sample hold', () => {
    expect(validateManualDriveRecording(take(), CLIP)).toEqual({ ok: true });
    const hold = take({ samples: [take().samples[0]!, { ...take().samples[0]!, timeS: CLIP }] });
    expect(validateManualDriveRecording(hold, CLIP)).toEqual({ ok: true });
  });

  it.each([
    ['ends before the clip', take({ samples: take().samples.slice(0, -1) }), 'samples.149.timeS'],
    ['starts after t=0', take({ samples: take().samples.slice(1) }), 'samples.0.timeS'],
    ['was driven against another clip length', take({ clipSeconds: CLIP + 1 }), 'clipSeconds'],
    ['has a non-finite sample', take({ samples: take().samples.map((s, i) => (i === 7 ? { ...s, x: Number.NaN } : s)) }), 'samples.7.x'],
    ['records a nonzero elevation', take({ samples: take().samples.map((s, i) => (i === 4 ? { ...s, y: 0.35 } : s)) }), 'samples.4.y'],
    ['has non-increasing times', take({ samples: take().samples.map((s, i) => (i === 5 ? { ...s, timeS: 0.08 } : s)) }), 'samples.5.timeS'],
    ['exceeds the sample budget', take({ samples: Array.from({ length: MANUAL_DRIVE_MAX_SAMPLES + 1 }, (_, k) => ({ ...take().samples[0]!, timeS: k * 1e-4 })) }), 'samples'],
  ])('rejects a take that %s', (_label, recording, path) => {
    const verdict = validateManualDriveRecording(recording, CLIP);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.path).toBe(path);
  });
});

describe('manualDrive structural checks', () => {
  it('accepts one take owning a pinned scene_absolute actor for the whole clip', () => {
    const report = validateTemplate(withManualDrive());
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('keeps discrete state and existence interactions beside the take', () => {
    const report = validateTemplate(withManualDrive({
      extra: [
        { id: 'blink', actor: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'set', target: { key: 'lights.indicator', value: 'left' } },
        { id: 'vanish', actor: 'ego', trigger: { kind: 'at', t: 2.5 }, verb: 'exist', target: { state: 'absent' } },
      ],
    }));
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('rejects any other motion interaction on the driven actor', () => {
    const report = validateTemplate(withManualDrive({
      extra: [{
        id: 'brake', actor: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'speed',
        target: { mode: 'stop' }, dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
      }],
    }));
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'axis_conflict', path: 'choreography.interactions.1' }),
    ]));
  });

  it('rejects a take that does not span [0, clipSeconds]', () => {
    const late = validateTemplate(withManualDrive({ trigger: { kind: 'at', t: 0.5 } }));
    expect(find(late.issues, 'axis_conflict').map((i) => i.path)).toContain('choreography.interactions.0.trigger');
    const open = validateTemplate(withManualDrive({ until: null }));
    expect(find(open.issues, 'axis_conflict').map((i) => i.path)).toContain('choreography.interactions.0.until');
  });

  it('rejects a malformed take with the recording path', () => {
    const report = validateTemplate(withManualDrive({ recording: take({ clipSeconds: CLIP + 1 }) }));
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'route_disconnected',
        path: 'choreography.interactions.0.target.recording.clipSeconds',
      }),
    ]));
  });

  it('rejects a take on an unpinned or static actor', () => {
    expect(codes(validateTemplate(withManualDrive({ pinned: false })).issues)).toContain('route_disconnected');
    expect(codes(validateTemplate(withManualDrive({ static: true })).issues)).toContain('static_actor_motion');
  });
});

function find(issues: ClauseResult[], code: IssueCode): ClauseResult[] {
  return issues.filter((i) => i.code === code);
}
