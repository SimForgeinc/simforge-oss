import { describe, expect, it } from 'vitest';

import { parseTemplate } from '../serialize.js';
import { validateTemplate } from '../validate/index.js';
import type { ClauseResult } from '../validate/issues.js';
import { ltapTemplateInput } from './v2-fixtures.js';

/**
 * `actorPolyline` and `timedPolyline` exist so a freehand route survives a move
 * to another map. The contract worth pinning is therefore not that they parse,
 * but that they drive a *portable* role without a map pin — which is exactly
 * what `customRoute` refuses to do — and that a half-timed route is refused
 * rather than silently half-obeyed.
 */

const CLIP = 20;

function withRouteTarget(target: unknown, options: { roles?: unknown[] } = {}) {
  const base = ltapTemplateInput();
  return parseTemplate({
    ...base,
    roles: options.roles ?? base.roles,
    choreography: {
      clipSeconds: CLIP,
      interactions: [{
        id: 'freehand',
        actor: 'ego',
        verb: 'route',
        trigger: { kind: 'at', t: 0 },
        target,
      }],
    },
    invariants: [],
  } as Parameters<typeof parseTemplate>[0]);
}

const errors = (issues: ClauseResult[]): ClauseResult[] =>
  issues.filter((issue) => issue.severity === 'error');

const at = (alongM: number, acrossM: number, timeS?: number) =>
  timeS === undefined ? { alongM, acrossM } : { alongM, acrossM, timeS };

describe('actorPolyline', () => {
  it('drives a portable role on an unpinned template, where customRoute cannot', () => {
    const portable = validateTemplate(withRouteTarget({
      mode: 'actorPolyline',
      points: [at(0, 0), at(30, -71), at(60, -71)],
    }));
    expect(errors(portable.issues)).toEqual([]);

    // The contrast that makes the target worth having: the same geometry as a
    // scene-space custom route is refused on this role, because that form is
    // map-bound.
    const bound = validateTemplate(withRouteTarget({
      mode: 'customRoute',
      points: [{ x: 0, z: 0 }, { x: 30, z: -71 }],
    }));
    expect(errors(bound.issues).map((issue) => issue.code)).toContain('route_disconnected');
  });

  it('carries a lateral offset far beyond what the frame cross-section can name', () => {
    // 71 m across is the measured case that a dLane/tFrac placement folds into
    // a neighbouring lane; the rigid form must keep it verbatim.
    const template = withRouteTarget({
      mode: 'actorPolyline',
      points: [at(0, 0), at(12, -253)],
    });
    const [interaction] = template.choreography.interactions;
    expect(interaction?.target).toMatchObject({
      mode: 'actorPolyline',
      points: [{ alongM: 0, acrossM: 0 }, { alongM: 12, acrossM: -253 }],
    });
  });

  it('accepts a fully timed route and treats one keyframe as complete', () => {
    expect(errors(validateTemplate(withRouteTarget({
      mode: 'actorPolyline',
      points: [at(0, 0, 0), at(20, -5, 1.5), at(40, -5, 3)],
    })).issues)).toEqual([]);

    expect(errors(validateTemplate(withRouteTarget({
      mode: 'actorPolyline',
      points: [at(5, 2, 0)],
    })).issues)).toEqual([]);
  });

  it('refuses a route that is only half timed', () => {
    const report = validateTemplate(withRouteTarget({
      mode: 'actorPolyline',
      points: [at(0, 0, 0), at(20, -5), at(40, -5, 3)],
    }));
    expect(errors(report.issues).map((issue) => issue.code)).toContain('route_disconnected');
  });

  it('refuses non-increasing keyframe times', () => {
    const report = validateTemplate(withRouteTarget({
      mode: 'actorPolyline',
      points: [at(0, 0, 0), at(20, -5, 2), at(40, -5, 2)],
    }));
    expect(errors(report.issues).map((issue) => issue.code)).toContain('route_disconnected');
  });
});

describe('timedPolyline', () => {
  it('refuses non-increasing keyframe times', () => {
    const report = validateTemplate(withRouteTarget({
      mode: 'timedPolyline',
      points: [
        { laneOffset: 0, s: 0, tFrac: 0, timeS: 0 },
        { laneOffset: 0, s: 10, tFrac: 0, timeS: 0 },
      ],
    }));
    expect(errors(report.issues).map((issue) => issue.code)).toContain('route_disconnected');
  });
});

describe('polyline point budget', () => {
  // The cap matches customRoute so converting one never drops a vertex.
  const framePose = (s: number) => ({ laneOffset: 0, s, tFrac: 0 });

  it('accepts the full budget a converted custom route can need', () => {
    expect(() => withRouteTarget({
      mode: 'polyline',
      points: Array.from({ length: 128 }, (_, index) => framePose(index)),
    })).not.toThrow();
  });

  it('still refuses more points than the budget', () => {
    expect(() => withRouteTarget({
      mode: 'polyline',
      points: Array.from({ length: 129 }, (_, index) => framePose(index)),
    })).toThrow();
  });
});

describe('rigidOffsetM on relative_to', () => {
  it('round-trips the pairwise offset that dLane/tFrac cannot express', () => {
    const base = ltapTemplateInput();
    const template = withRouteTarget(
      { mode: 'polyline', points: [{ laneOffset: 0, s: 0, tFrac: 0 }, { laneOffset: 0, s: 10, tFrac: 0 }] },
      {
        roles: [
          base.roles![0]!,
          {
            id: 'partner',
            kind: 'relative_to',
            actor: { class: 'car', catalogId: 'sedan.generic' },
            ref: 'ego',
            dsM: 12,
            rigidOffsetM: { alongM: 12, acrossM: -71 },
          },
        ],
      },
    );
    const partner = template.roles.find((role) => role.id === 'partner');
    expect(partner).toMatchObject({ rigidOffsetM: { alongM: 12, acrossM: -71 } });
  });
});
