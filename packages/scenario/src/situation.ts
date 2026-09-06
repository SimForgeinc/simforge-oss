import { z } from 'zod';
import { ScenarioValidationError, toScenarioIssues, type ScenarioIssue } from './errors.js';
import { canonicalize, deepFreeze } from './serialize.js';
import { Sha256 } from './sha256.js';
import { RoleIdSchema } from './schema/v2/common.js';
import { ConditionSchema, type Condition, type PointRef } from './schema/v2/interactions.js';
import { ScenarioTemplateV2Schema, ScenarioTemplateV2ObjectSchema } from './schema/v2/template.js';
import { applyTemplateOp, type TemplateOp } from './template-operations.js';
import { structuralIssues, collectExpressions } from './validate/structural.js';
import { collectParamRefs } from './expr/index.js';

const id = z.string().min(1).max(200);
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase SHA-256');
const ids = z.array(id).refine((v) => new Set(v).size === v.length, 'duplicate identifier');
const effect = z.enum(['bounds', 'ground', 'collision', 'occlusion', 'driveability']);

export const SituationSourceSchema = z.strictObject({
  id,
  kind: z.enum(['authored', 'nurec', 'twin']),
  mapId: id,
  artifacts: z.array(z.strictObject({
    id, uri: z.string().min(1), sha256: digest,
    kind: z.enum(['mesh', 'rigid-track', 'baked', 'observation', 'map', 'point-cloud', 'image', 'video']),
  })),
  frame: z.strictObject({
    id,
    // SimForge: (localX, up, -localY); Blender: (localX, localY, up); XODR: (localX, localY).
    axes: z.enum(['simforge-y-up', 'blender-z-up', 'xodr-xy']),
    units: z.literal('m'),
  }),
  time: z.strictObject({ origin: finite, unit: z.literal('s') }),
  assumptions: z.array(z.string().min(1)),
});

export const SituationQuestionSchema = z.strictObject({
  brief: z.string().min(1), hypothesis: z.string(), falsifier: z.string(),
});

export const SituationParticipantSchema = z.strictObject({
  roleId: RoleIdSchema,
  intention: z.string().min(1),
  // Half-open [startS,endS) intervals: handoffs may share a boundary, never an interval.
  authority: z.array(z.strictObject({
    startS: nonnegative, endS: nonnegative, kind: z.enum(['recorded', 'controller', 'policy']),
  })).min(1),
  appearance: z.strictObject({ kind: z.enum(['mesh', 'rigid-track', 'baked']), sourceId: id }),
  information: z.array(z.strictObject({
    subjectRoleId: RoleIdSchema,
    source: z.enum(['truth', 'visibility', 'detection', 'observation']),
    reactionDelayS: nonnegative,
  })),
});

export const SituationEventSchema = z.strictObject({
  id, condition: ConditionSchema, windowS: z.tuple([nonnegative, nonnegative]), toleranceS: nonnegative,
});
export const SituationConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id, kind: z.literal('event-offset'), before: id, after: id, minS: finite, maxS: finite }),
  z.strictObject({ id, kind: z.literal('event-occurs'), eventId: id }),
]);
export const SituationKnobSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id, kind: z.literal('role-speed'), roleId: RoleIdSchema, min: nonnegative, max: nonnegative }),
  z.strictObject({ id, kind: z.literal('role-position'), roleId: RoleIdSchema, axis: z.enum(['x', 'z', 's']), min: finite, max: finite }),
  z.strictObject({ id, kind: z.literal('interaction-time'), interactionId: id, min: nonnegative, max: nonnegative }),
]);

/** Artifact claims are provenance, not a second geometry engine. Consumers verify bytes before lowering. */
export const GeometryPatchManifestSchema = z.strictObject({
  id,
  status: z.enum(['visual-only', 'executable']),
  sourceArtifacts: z.array(z.strictObject({ sourceId: id, sha256: digest })).min(1),
  assets: z.array(z.strictObject({
    id, uri: z.string().min(1), sha256: digest,
    kind: z.enum(['mesh', 'bounds', 'ground', 'collision', 'occlusion', 'driveability']),
  })).min(1),
  affected: z.strictObject({ sourceIds: ids.min(1), objectIds: ids, roleIds: z.array(RoleIdSchema) }),
  requiredEffects: z.array(effect).refine((v) => new Set(v).size === v.length, 'duplicate effect'),
  satisfiedEffects: z.array(z.strictObject({ effect, assetId: id })),
});

const changesShape = {
  question: SituationQuestionSchema,
  participants: z.array(SituationParticipantSchema),
  events: z.array(SituationEventSchema),
  constraints: z.array(SituationConstraintSchema),
  knobs: z.array(SituationKnobSchema),
  geometryPatches: z.array(GeometryPatchManifestSchema),
};
const programObjectSchema = z.strictObject({
  situationVersion: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  source: SituationSourceSchema, template: ScenarioTemplateV2Schema, ...changesShape,
});

/** Public values are recursively readonly as well as frozen at the parse boundary. */
export type SituationReadonly<T> = T extends object
  ? { readonly [K in keyof T]: SituationReadonly<T[K]> } : T;
export type SituationSource = SituationReadonly<z.output<typeof SituationSourceSchema>>;
export type SituationParticipant = SituationReadonly<z.output<typeof SituationParticipantSchema>>;
export type SituationEvent = SituationReadonly<z.output<typeof SituationEventSchema>>;
export type SituationConstraint = SituationReadonly<z.output<typeof SituationConstraintSchema>>;
export type SituationKnob = SituationReadonly<z.output<typeof SituationKnobSchema>>;
export type GeometryPatchManifest = SituationReadonly<z.output<typeof GeometryPatchManifestSchema>>;
export type SituationProgram = SituationReadonly<z.output<typeof programObjectSchema>>;

function inspectProgram(doc: z.output<typeof programObjectSchema>): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  const issue = (path: string, code: string, message: string): void => { issues.push({ path, code, message }); };
  const unique = (values: readonly string[], path: string): void => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) issue(`${path}.${index}`, 'duplicate_id', `duplicate identifier "${value}"`);
      seen.add(value);
    });
  };
  const need = (values: ReadonlySet<string>, value: string, path: string): void => {
    if (!values.has(value)) issue(path, 'reference_unknown', `unknown reference "${value}"`);
  };
  const roles = new Set(doc.template.roles.map((v) => v.id));
  const features = new Set(doc.template.anchor.features.map((v) => v.id));
  const controls = new Set(doc.template.trafficControls.map((v) => v.id));
  const interactions = new Set(doc.template.choreography.interactions.map((v) => v.id));
  const events = new Set(doc.events.map((v) => v.id));
  const artifacts = new Map(doc.source.artifacts.map((v) => [v.id, v]));
  const sources = new Set(artifacts.keys());
  const appearances = new Map<string, { kind: string; uri: string; sha256: string }>(artifacts);
  const meshOwners = new Map<string, GeometryPatchManifest>();
  const assetIdentities = new Map<string, { kind: string; uri: string; sha256: string }>(artifacts);
  doc.geometryPatches.forEach((patch, patchIndex) => patch.assets.forEach((asset, assetIndex) => {
    const previous = assetIdentities.get(asset.id);
    if (previous && (previous.kind !== asset.kind || previous.uri !== asset.uri || previous.sha256 !== asset.sha256)) {
      issue(`geometryPatches.${patchIndex}.assets.${assetIndex}`, 'asset_identity_conflict', 'asset identifier has conflicting kind, URI or digest');
    }
    assetIdentities.set(asset.id, asset);
    if (asset.kind === 'mesh') {
      if (artifacts.has(asset.id) || meshOwners.has(asset.id)) issue(`geometryPatches.${patchIndex}.assets.${assetIndex}.id`, 'asset_identity_conflict', 'generated mesh must have one manifest owner and cannot shadow an immutable source');
      appearances.set(asset.id, asset);
      meshOwners.set(asset.id, patch);
    }
  }));
  const appearanceIds = new Set(appearances.keys());
  unique(doc.source.artifacts.map((v) => v.id), 'source.artifacts');
  unique(doc.participants.map((v) => v.roleId), 'participants');
  for (const key of ['events', 'constraints', 'knobs', 'geometryPatches'] as const) unique(doc[key].map((v) => v.id), key);
  if (doc.template.sourceMap && doc.template.sourceMap.mapId !== doc.source.mapId) {
    issue('template.sourceMap.mapId', 'source_mismatch', 'template source map must match the immutable situation source');
  }
  // Reuse canonical reference checks without requiring an already runnable draft.
  for (const item of structuralIssues(doc.template)) {
    if (item.code.endsWith('_ref_unknown')) issues.push({ path: `template.${item.path}`, code: item.code, message: item.message });
  }
  doc.participants.forEach((participant, index) => {
    const path = `participants.${index}`;
    need(roles, participant.roleId, `${path}.roleId`);
    need(appearanceIds, participant.appearance.sourceId, `${path}.appearance.sourceId`);
    const artifact = appearances.get(participant.appearance.sourceId);
    if (artifact && artifact.kind !== participant.appearance.kind) issue(`${path}.appearance.kind`, 'appearance_mismatch', 'appearance kind must match its source artifact');
    const owner = meshOwners.get(participant.appearance.sourceId);
    if (owner && !owner.affected.roleIds.includes(participant.roleId)) issue(`${path}.appearance.sourceId`, 'appearance_mismatch', 'generated appearance must be owned by a manifest affecting this role');
    const ordered = participant.authority.map((interval, i) => ({ ...interval, i })).sort((a, b) => a.startS - b.startS);
    ordered.forEach((interval, i) => {
      if (interval.startS >= interval.endS) issue(`${path}.authority.${interval.i}`, 'authority_interval', 'authority interval must have positive duration');
      if (i > 0 && interval.startS < ordered[i - 1]!.endS) issue(`${path}.authority.${interval.i}`, 'authority_conflict', 'authority intervals must not overlap');
    });
    participant.information.forEach((information, i) => need(roles, information.subjectRoleId, `${path}.information.${i}.subjectRoleId`));
  });
  const point = (value: PointRef, path: string): void => {
    if ('role' in value) need(roles, value.role, `${path}.role`);
    if ('feature' in value) need(features, value.feature, `${path}.feature`);
  };
  const condition = (value: Condition, path: string): void => {
    switch (value.kind) {
      case 'and': case 'or': value.operands.forEach((v, i) => condition(v, `${path}.operands.${i}`)); return;
      case 'not': condition(value.operand, `${path}.operand`); return;
      case 'distance': need(roles, value.from, `${path}.from`); point(value.to, `${path}.to`); return;
      case 'reaches': need(roles, value.of, `${path}.of`); point(value.region, `${path}.region`); return;
      case 'signal':
        if ('feature' in value.signal) need(features, value.signal.feature, `${path}.signal.feature`);
        if ('control' in value.signal) need(controls, value.signal.control, `${path}.signal.control`);
        return;
      default:
        need(roles, value.of, `${path}.of`);
        if ('to' in value) need(roles, value.to, `${path}.to`);
        if ('by' in value) need(roles, value.by, `${path}.by`);
        if ('with' in value && value.with !== 'any') need(roles, value.with, `${path}.with`);
        if (value.kind === 'detected' && value.sensor !== undefined) {
          const observer = doc.template.roles.find((role) => role.id === value.by);
          if (observer && !observer.actor.sensors.some((sensor) => sensor.id === value.sensor)) issue(`${path}.sensor`, 'reference_unknown', `unknown sensor "${value.sensor}" on role "${value.by}"`);
        }
    }
  };
  const params = new Set(doc.template.params.declarations.map((v) => v.id));
  doc.events.forEach((event, index) => {
    const path = `events.${index}`;
    if (event.windowS[0] > event.windowS[1]) issue(`${path}.windowS`, 'invalid_bounds', 'window start must not exceed end');
    condition(event.condition, `${path}.condition`);
    for (const expression of collectExpressions(event.condition)) {
      for (const ref of collectParamRefs(expression.expr)) need(params, ref, `${path}.condition.${expression.path}`);
    }
  });
  doc.constraints.forEach((constraint, index) => {
    const path = `constraints.${index}`;
    if (constraint.kind === 'event-occurs') need(events, constraint.eventId, `${path}.eventId`);
    else {
      need(events, constraint.before, `${path}.before`); need(events, constraint.after, `${path}.after`);
      if (constraint.minS > constraint.maxS) issue(path, 'invalid_bounds', 'minS must not exceed maxS');
      if (constraint.before === constraint.after && (constraint.minS > 0 || constraint.maxS < 0)) issue(path, 'constraint_conflict', 'an event has zero offset from itself');
    }
  });
  const knobTargets = new Set<string>();
  doc.knobs.forEach((knob, index) => {
    const path = `knobs.${index}`;
    const target = knob.kind === 'interaction-time' ? `${knob.kind}:${knob.interactionId}` : `${knob.kind}:${knob.roleId}:${knob.kind === 'role-position' ? knob.axis : ''}`;
    if (knobTargets.has(target)) issue(path, 'knob_conflict', 'only one knob may bound a target');
    knobTargets.add(target);
    if (knob.min > knob.max) issue(path, 'invalid_bounds', 'min must not exceed max');
    if (knob.kind === 'interaction-time') need(interactions, knob.interactionId, `${path}.interactionId`);
    else need(roles, knob.roleId, `${path}.roleId`);
  });
  doc.geometryPatches.forEach((patch, index) => {
    const path = `geometryPatches.${index}`;
    unique(patch.sourceArtifacts.map((v) => v.sourceId), `${path}.sourceArtifacts`);
    unique(patch.assets.map((v) => v.id), `${path}.assets`);
    unique(patch.affected.roleIds, `${path}.affected.roleIds`);
    unique(patch.satisfiedEffects.map((v) => v.effect), `${path}.satisfiedEffects`);
    const pinned = new Set(patch.sourceArtifacts.map((v) => v.sourceId));
    patch.sourceArtifacts.forEach((pin, i) => {
      need(sources, pin.sourceId, `${path}.sourceArtifacts.${i}.sourceId`);
      if (artifacts.get(pin.sourceId)?.sha256 !== pin.sha256) issue(`${path}.sourceArtifacts.${i}.sha256`, 'source_digest_mismatch', 'source digest must match the immutable source artifact');
    });
    patch.affected.sourceIds.forEach((ref, i) => need(pinned, ref, `${path}.affected.sourceIds.${i}`));
    patch.affected.roleIds.forEach((ref, i) => need(roles, ref, `${path}.affected.roleIds.${i}`));
    const assets = new Map(patch.assets.map((v) => [v.id, v]));
    const satisfied = new Set(patch.satisfiedEffects.map((v) => v.effect));
    patch.satisfiedEffects.forEach((claim, i) => {
      const asset = assets.get(claim.assetId);
      if (!asset) issue(`${path}.satisfiedEffects.${i}.assetId`, 'reference_unknown', 'effect evidence must name a patch asset');
      else if (asset.kind !== claim.effect) issue(`${path}.satisfiedEffects.${i}`, 'geometry_effect_conflict', 'effect evidence asset kind must match the claimed effect');
      if (!patch.requiredEffects.includes(claim.effect)) issue(`${path}.satisfiedEffects.${i}.effect`, 'geometry_effect_conflict', 'satisfied effect must be declared required');
    });
    if (patch.status === 'executable') {
      if (patch.requiredEffects.length === 0) issue(`${path}.requiredEffects`, 'geometry_effect_missing', 'executable patch must declare its effects');
      patch.requiredEffects.forEach((required) => {
        if (!satisfied.has(required)) issue(`${path}.requiredEffects`, 'geometry_effect_missing', `executable patch lacks ${required} evidence`);
      });
    } else if (patch.requiredEffects.some((v) => v !== 'bounds') || patch.satisfiedEffects.some((v) => v.effect !== 'bounds')) {
      issue(path, 'geometry_effect_conflict', 'visual-only patches cannot claim executable geometry effects');
    }
  });
  return issues;
}

export const SituationProgramSchema = programObjectSchema.superRefine((doc, ctx) => {
  for (const issue of inspectProgram(doc)) ctx.addIssue({ code: 'custom', path: issue.path.split('.'), message: `${issue.code}: ${issue.message}` });
});

function parsed<S extends z.ZodType>(schema: S, input: unknown, description: string): z.output<S> {
  let detached: unknown;
  try { detached = structuredClone(input); }
  catch (error) {
    throw new ScenarioValidationError(description, [{ path: '', code: 'invalid_data', message: error instanceof Error ? error.message : String(error) }]);
  }
  const result = schema.safeParse(detached);
  if (!result.success) throw new ScenarioValidationError(description, toScenarioIssues(result.error.issues));
  return result.data;
}

export function parseSituationProgram(input: unknown): SituationProgram {
  const result = parsed(programObjectSchema, input, 'invalid situation program');
  // Canonical extensions permit JSON data; reject non-finite values there too.
  try { canonicalize(result); }
  catch (error) {
    throw new ScenarioValidationError('invalid situation program', [{ path: '', code: 'invalid_data', message: error instanceof Error ? error.message : String(error) }]);
  }
  const issues = inspectProgram(result);
  if (issues.length) throw new ScenarioValidationError('invalid situation program', issues);
  return deepFreeze(result);
}

export interface CreateSituationProgramInput {
  readonly source: SituationSource;
  readonly template: SituationProgram['template'];
  readonly question: SituationProgram['question'];
  readonly participants?: SituationProgram['participants'];
  readonly events?: SituationProgram['events'];
  readonly constraints?: SituationProgram['constraints'];
  readonly knobs?: SituationProgram['knobs'];
  readonly geometryPatches?: SituationProgram['geometryPatches'];
}

const createSchema = programObjectSchema.omit({ situationVersion: true, revision: true }).partial({
  participants: true, events: true, constraints: true, knobs: true, geometryPatches: true,
});

export function createSituationProgram(input: CreateSituationProgramInput): SituationProgram {
  return parseSituationProgram({
    participants: [], events: [], constraints: [], knobs: [], geometryPatches: [],
    ...parsed(createSchema, input, 'invalid situation creation'), situationVersion: 1, revision: 0,
  });
}

/** Same key sorting, float normalization and portable SHA-256 as canonical scenario artifacts. */
export function situationDigest(program: SituationProgram): string {
  return new Sha256().update(new TextEncoder().encode(JSON.stringify(canonicalize(program)))).digestHex();
}

// Derive payload validation from the canonical template schema, not a parallel truth model.
const shape = ScenarioTemplateV2ObjectSchema.shape;
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const operationSchemas = [
  z.strictObject({ type: z.literal('setTemplateMeta'), patch: shape.meta.pick({ name: true, description: true, appVersion: true, archetype: true, tags: true, author: true, negativeControl: true }).partial() }),
  z.strictObject({ type: z.literal('setSourceMap'), sourceMap: shape.sourceMap.unwrap().nullable() }),
  z.strictObject({ type: z.literal('setEnvironment'), environment: shape.environment }),
  z.strictObject({ type: z.literal('moveRole'), id, toIndex: position }),
  z.strictObject({ type: z.literal('setMetricSubject'), roleId: RoleIdSchema.nullable() }),
  z.strictObject({ type: z.literal('setClip'), clipSeconds: finite.positive().optional(), warmupSeconds: nonnegative.optional() }),
  z.strictObject({ type: z.literal('setTemplateExtension'), key: id, value: z.json().optional() }),
] as const;
const collections = [
  ['Param', 'param', shape.params.unwrap().shape.declarations.unwrap().element],
  ['Role', 'role', shape.roles.unwrap().element],
  ['Interaction', 'interaction', shape.choreography.unwrap().shape.interactions.unwrap().element],
  ['ReasoningTraceSegment', 'segment', shape.reasoningTrace.unwrap().element],
  ['MapSignalPlan', 'plan', shape.mapSignalPlans.unwrap().element],
  ['Prop', 'prop', shape.props.unwrap().element],
  ['Invariant', 'invariant', shape.invariants.unwrap().element],
  ['Variant', 'variant', shape.variants.unwrap().element],
] as const;
const collectionOperationSchemas = collections.flatMap(([name, field, schema]) => [
  z.strictObject({ type: z.literal(`add${name}`), [field]: schema, index: position.optional() }),
  z.strictObject({ type: z.literal(`replace${name}`), id, [field]: schema }),
  z.strictObject({ type: z.literal(`remove${name}`), id }),
]);
type ParsedSituationTransaction = Omit<SituationTransaction, 'templateOps'> & { readonly templateOps: readonly TemplateOp[] };
export const SituationTransactionSchema: z.ZodType<ParsedSituationTransaction> = z.strictObject({
  baseRevision: position, baseDigest: digest, label: z.string().min(1),
  templateOps: z.array(z.discriminatedUnion('type', [...operationSchemas, ...collectionOperationSchemas])).default([]),
  changes: z.strictObject(changesShape).partial().optional(),
  preserve: z.strictObject({ roles: ids.optional(), interactions: ids.optional() }).optional(),
}) as z.ZodType<ParsedSituationTransaction>;
export interface SituationTransaction {
  readonly baseRevision: number;
  readonly baseDigest: string;
  readonly label: string;
  readonly templateOps?: readonly TemplateOp[];
  readonly changes?: Partial<Pick<SituationProgram, keyof typeof changesShape>>;
  readonly preserve?: { readonly roles?: readonly string[]; readonly interactions?: readonly string[] };
}
export interface SituationTransactionResult {
  readonly program: SituationProgram;
  readonly changedPaths: readonly string[];
  readonly digest: string;
}

function fail(path: string, code: string, message: string): never {
  throw new ScenarioValidationError('invalid situation transaction', [{ path, code, message }]);
}

/** Stage every operation on a private parsed copy; validate once, then publish a frozen revision. */
export function applySituationTransaction(program: SituationProgram, transaction: SituationTransaction): SituationTransactionResult {
  const tx = parsed(SituationTransactionSchema, transaction, 'invalid situation transaction');
  if (tx.baseRevision !== program.revision) fail('baseRevision', 'stale_revision', 'transaction revision does not match base');
  if (tx.baseDigest !== situationDigest(program)) fail('baseDigest', 'stale_digest', 'transaction digest does not match base');
  if (program.revision === Number.MAX_SAFE_INTEGER) fail('baseRevision', 'revision_overflow', 'revision cannot be incremented safely');
  const base = parseSituationProgram(program);
  const candidate = parsed(programObjectSchema, base, 'invalid situation base');
  tx.templateOps.forEach((operation, index) => {
    try { applyTemplateOp(candidate.template, operation as TemplateOp); }
    catch (error) { fail(`templateOps.${index}`, 'template_operation_failed', error instanceof Error ? error.message : String(error)); }
  });
  const next = parseSituationProgram({ ...candidate, ...tx.changes, revision: base.revision + 1 });
  const exact = (value: unknown): string => JSON.stringify(value);
  for (const roleId of tx.preserve?.roles ?? []) {
    const oldRole = base.template.roles.find((v) => v.id === roleId);
    if (!oldRole) fail('preserve.roles', 'reference_unknown', `unknown preserved role "${roleId}"`);
    const oldParticipant = base.participants.find((v) => v.roleId === roleId);
    if (exact(oldRole) !== exact(next.template.roles.find((v) => v.id === roleId)) || exact(oldParticipant) !== exact(next.participants.find((v) => v.roleId === roleId))) fail('preserve.roles', 'preserved_entity_changed', `preserved role "${roleId}" changed`);
  }
  for (const interactionId of tx.preserve?.interactions ?? []) {
    const old = base.template.choreography.interactions.find((v) => v.id === interactionId);
    if (!old) fail('preserve.interactions', 'reference_unknown', `unknown preserved interaction "${interactionId}"`);
    if (exact(old) !== exact(next.template.choreography.interactions.find((v) => v.id === interactionId))) fail('preserve.interactions', 'preserved_entity_changed', `preserved interaction "${interactionId}" changed`);
  }
  const changedPaths: string[] = ['revision'];
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (exact(base.template[key]) !== exact(next.template[key])) changedPaths.push(`template.${key}`);
  }
  for (const key of Object.keys(changesShape) as (keyof typeof changesShape)[]) {
    if (exact(base[key]) !== exact(next[key])) changedPaths.push(key);
  }
  return deepFreeze({ program: next, changedPaths: changedPaths.sort(), digest: situationDigest(next) });
}
