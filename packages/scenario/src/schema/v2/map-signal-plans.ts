/** Map-bound edits to the phase plan of existing physical traffic signals. */
import { z } from 'zod';

import { ControlIndicationSchema } from './traffic-controls.js';

const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

/** A normal road signal cannot display lane-control or human-director states. */
export const MAP_SIGNAL_INDICATIONS = [
  'green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off',
] as const;

const SignalStageReferenceSchema = z.strictObject({
  controllerId: z.string().min(1).max(256),
  headId: z.string().min(1).max(256),
});

export const MapSignalPlanClipSchema = z.strictObject({
  id: IdSchema,
  startS: z.number().finite().min(0),
  endS: z.number().finite().gt(0),
  reference: SignalStageReferenceSchema.extend({
    additionalStages: z.array(SignalStageReferenceSchema).optional(),
    displayHeadIds: z.array(z.string().min(1).max(256)).transform((ids) => [...new Set(ids)]).optional(),
    movements: z.array(z.strictObject({
      approachLaneRsl: z.string().min(1).max(256),
      connectingLaneRsl: z.string().min(1).max(256),
    })).optional(),
  }).check((ctx) => {
    const movements = new Set<string>();
    ctx.value.movements?.forEach((movement, index) => {
      const key = JSON.stringify([movement.approachLaneRsl, movement.connectingLaneRsl]);
      if (movements.has(key)) ctx.issues.push({
        code: 'custom', path: ['movements', index], input: movement,
        message: 'duplicate exact signal movement',
      });
      movements.add(key);
    });
    const seen = new Set([ctx.value.controllerId]);
    ctx.value.additionalStages?.forEach((stage, index) => {
      if (seen.has(stage.controllerId)) {
        ctx.issues.push({
          code: 'custom', path: ['additionalStages', index, 'controllerId'], input: stage.controllerId,
          message: `duplicate map signal controller stage "${stage.controllerId}"`,
        });
      }
      seen.add(stage.controllerId);
    });
  }),
  indication: ControlIndicationSchema.refine(
    (value): value is typeof MAP_SIGNAL_INDICATIONS[number] => MAP_SIGNAL_INDICATIONS.includes(value as typeof MAP_SIGNAL_INDICATIONS[number]),
    { message: 'map signal clips require a normal-signal indication' },
  ),
}).check((ctx) => {
  if (ctx.value.endS <= ctx.value.startS) {
    ctx.issues.push({
      code: 'custom', path: ['endS'], input: ctx.value.endS,
      message: 'map signal clip endS must be greater than startS (clips are half-open)',
    });
  }
});

export const MapSignalPlanSchema = z.strictObject({
  id: IdSchema,
  version: z.literal(1),
  binding: z.strictObject({
    mapId: z.string().min(1).max(256),
    junctionId: z.string().min(1).max(256),
    controlDigest: z.string().min(1).max(256),
  }),
  clips: z.array(MapSignalPlanClipSchema).max(256).default([]),
  displayBaselines: z.array(z.strictObject({
    headId: z.string().min(1).max(256),
    phases: z.array(z.strictObject({
      phase: z.enum(MAP_SIGNAL_INDICATIONS),
      durationS: z.number().finite().gt(0),
    })).min(1),
    offsetS: z.number().finite(),
    loop: z.boolean(),
  })).optional(),
  routeSignals: z.array(z.strictObject({
    id: z.string().min(1).max(256),
    actorId: z.string().min(1).max(256),
    routePointsHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectedByClipIds: z.array(z.string().min(1)),
    baselineOnly: z.boolean().optional(),
    coordinationId: z.string().min(1).max(256).optional(),
    darkFallback: z.enum(['all_way_stop', 'uncontrolled', 'yield']).optional(),
    darkDwellS: z.number().finite().gt(0).optional(),
    s: z.number().finite().min(0),
    phases: z.array(z.strictObject({
      phase: z.enum(MAP_SIGNAL_INDICATIONS),
      durationS: z.number().finite().gt(0),
    })).min(1),
    offsetS: z.number().finite(),
    loop: z.boolean(),
  })).optional(),
}).check((ctx) => {
  const routeSignalIds = new Set<string>();
  const clipIds = new Set(ctx.value.clips.map((clip) => clip.id));
  ctx.value.routeSignals?.forEach((signal, index) => {
    if (routeSignalIds.has(signal.id)) ctx.issues.push({
      code: 'custom', path: ['routeSignals', index, 'id'], input: signal.id,
      message: `duplicate route signal "${signal.id}"`,
    });
    routeSignalIds.add(signal.id);
    const selected = new Set<string>();
    signal.selectedByClipIds.forEach((id, clipIndex) => {
      if (!clipIds.has(id) || selected.has(id)) ctx.issues.push({
        code: 'custom', path: ['routeSignals', index, 'selectedByClipIds', clipIndex], input: id,
        message: `unknown or duplicate selected clip "${id}"`,
      });
      selected.add(id);
    });
  });
  const displayHeads = new Set<string>();
  ctx.value.displayBaselines?.forEach((baseline, index) => {
    if (displayHeads.has(baseline.headId)) ctx.issues.push({
      code: 'custom', path: ['displayBaselines', index, 'headId'], input: baseline.headId,
      message: `duplicate display baseline head "${baseline.headId}"`,
    });
    displayHeads.add(baseline.headId);
  });
  const seen = new Set<string>();
  ctx.value.clips.forEach((clip, index) => {
    if (seen.has(clip.id)) {
      ctx.issues.push({
        code: 'custom', path: ['clips', index, 'id'], input: clip.id,
        message: `duplicate map signal clip id "${clip.id}"`,
      });
    }
    seen.add(clip.id);
  });
  const ordered = ctx.value.clips
    .map((clip, index) => ({ clip, index }))
    .sort((a, b) => a.clip.startS - b.clip.startS || a.clip.endS - b.clip.endS || a.clip.id.localeCompare(b.clip.id));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.clip.startS < previous.clip.endS) {
      ctx.issues.push({
        code: 'custom', path: ['clips', current.index, 'startS'], input: current.clip.startS,
        message: `map signal clip overlaps "${previous.clip.id}"; clip intervals are half-open [startS, endS)`,
      });
    }
  }
});

export type MapSignalPlanClip = z.infer<typeof MapSignalPlanClipSchema>;
export type MapSignalPlan = z.infer<typeof MapSignalPlanSchema>;
export type MapSignalIndication = typeof MAP_SIGNAL_INDICATIONS[number];
