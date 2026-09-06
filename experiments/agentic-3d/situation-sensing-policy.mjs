import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  ActorSpecSchema, ActorSensorSchema, SensorRigPresetSchema, EntityIdSchema,
  DEFAULT_ACTOR_DIMS, BUILT_IN_SENSOR_RIGS, defaultDashCamera, defaultLidar,
  defaultRadar, instantiateSensorRig, parseSituationProgram,
} from '@simforge-oss/scenario';
import { lowerSensor, catalogActorDims } from '@simforge-oss/compiler';
import {
  canonicalJson, contentHash, parseSimScenarioInput, sensorChannelKey,
  SENSOR_TRACE_REASON_LEGEND, SENSOR_TRACE_STATUS_LEGEND,
} from '@simforge-oss/engine';
import { authoringRuntimeIdentity } from './runtime-identity.mjs';

const SCHEMA = 'simforge.brief-sensing-policy/v1';
const constructors = { defaultDashCamera, defaultLidar, defaultRadar };
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
const clone = value => JSON.parse(canonicalJson(value));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const limitations = [
  'This is a declared instrumentation assumption, not human sensing, calibrated attention, or a scenario success judgment.',
  'Mounts use the canonical materializer dimension precedence: authored actor.dims, built-in catalogActorDims(catalogId), then class defaults. Unknown/custom catalog metadata requires explicit authored dimensions. Calling a sensor constructor directly with catalogId but no dims would instead use class defaults: do not confuse these boxes. No geometry or sensors are silently rewritten.',
  'Executed synthetic detection channels are not qualified sensor pixels. Diagnostic actor-relative renders are not sensor observations.',
  'No positive report is not evidence of absence. A declared sensor without an executed channel is unavailable.',
];
function fail(code, at, reason) {
  const error = new Error(`${at}: ${reason}`);
  error.issues = [{ code, path: at, reason }];
  throw error;
}
function requireThat(condition, code, at, reason) { if (!condition) fail(code, at, reason); }
function keys(value, names, at) {
  requireThat(ownObject(value) && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name)), 'invalid_fields', at, `Expected exactly: ${names.join(', ')}`);
}
function text(value, at) {
  requireThat(typeof value === 'string' && value.trim().length > 0, 'invalid_text', at, 'Expected nonempty text');
}
function parsed(schema, value, at) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error(`Invalid canonical definition at ${at}`);
    error.issues = result.error.issues.map(issue => ({ code: 'canonical_schema', path: `${at}${issue.path.length ? '.' + issue.path.join('.') : ''}`, reason: issue.message }));
    throw error;
  }
  return result.data;
}
function issuesFrom(error, at) {
  return Array.isArray(error?.issues) ? error.issues.map(issue => ({
    code: issue.code ?? 'invalid_data', path: Array.isArray(issue.path) ? issue.path.join('.') : issue.path ?? at,
    reason: issue.reason ?? issue.message ?? String(error),
  })) : [{ code: 'invalid_data', path: at, reason: String(error?.message ?? error) }];
}
function referenceActors() {
  return [...Object.keys(DEFAULT_ACTOR_DIMS).sort().map(className => ({ class: className })),
    { class: 'car', dims: { length: 4.25, width: 1.75, height: 1.4 } }];
}
/** Runtime identity of the policy: the native addon, published package artifacts, this lowering module and the canonical constructors it depends on. */
function runtimeIdentity() {
  const runtime = authoringRuntimeIdentity();
  return { schema: runtime.schema, node: runtime.node, native: runtime.native, engine: runtime.native.engineVersion,
    packages: runtime.packages.map(({ name, version, files }) => ({ name, version, artifactsSha256: createHash('sha256').update(canonicalJson(files)).digest('hex') })),
    local: runtime.local.filter(row => row.path === 'experiments/agentic-3d/situation-sensing-policy.mjs'),
    algorithm: 'canonical-authored-actor-mounts/v1',
    referenceActors: referenceActors(),
    constructors: Object.entries(constructors).map(([name, build]) => ({ name,
      referenceSensors: referenceActors().map(actor => parsed(ActorSensorSchema, build(actor, `reference-${name}`), `runtime.${name}`)) })),
    rigs: BUILT_IN_SENSOR_RIGS.map(preset => parsed(SensorRigPresetSchema, preset, 'runtime.rigs')) };
}

/** Only canonical definitions and instrumentation caveats: no scene exemplars. */
export function sensingCatalog() {
  const runtime = runtimeIdentity();
  return freeze({ schema: 'simforge.sensing-catalog/v1', runtime,
    referenceActors: runtime.referenceActors, constructors: runtime.constructors, rigs: runtime.rigs,
    limitations: [...limitations] });
}
function briefLabels(brief) {
  requireThat(ownObject(brief), 'invalid_brief', 'brief', 'Expected the entire frozen brief record');
  text(brief.id, 'brief.id');
  requireThat(Array.isArray(brief.participantRoles) && brief.participantRoles.length > 0,
    'invalid_brief', 'brief.participantRoles', 'Expected nonempty exact participant label array');
  brief.participantRoles.forEach((label, i) => text(label, `brief.participantRoles.${i}`));
  requireThat(new Set(brief.participantRoles).size === brief.participantRoles.length,
    'duplicate_participant', 'brief.participantRoles', 'Participant labels must be unique');
  return brief.participantRoles;
}
function resolveRecipe(recipe, actor, at = 'recipe') {
  requireThat(ownObject(recipe), 'invalid_recipe', at, 'Expected a canonical constructor selection or frozen rig');
  if (recipe.kind === 'constructors') {
    keys(recipe, ['kind', 'sensors'], at);
    requireThat(Array.isArray(recipe.sensors) && recipe.sensors.length > 0, 'invalid_recipe', `${at}.sensors`, 'Select at least one canonical sensor constructor');
    const ids = new Set();
    return recipe.sensors.map((selection, index) => {
      const p = `${at}.sensors.${index}`;
      keys(selection, ['constructor', 'id'], p);
      requireThat(Object.hasOwn(constructors, selection.constructor), 'unknown_constructor', `${p}.constructor`, 'Select defaultDashCamera, defaultLidar, or defaultRadar');
      parsed(EntityIdSchema, selection.id, `${p}.id`);
      requireThat(!ids.has(selection.id), 'duplicate_sensor', `${p}.id`, 'Sensor IDs must be distinct within a recipe');
      ids.add(selection.id);
      return parsed(ActorSensorSchema, constructors[selection.constructor](actor, selection.id), p);
    });
  }
  requireThat(recipe.kind === 'rig', 'invalid_recipe', `${at}.kind`, 'Expected constructors or rig');
  keys(recipe, ['kind', 'preset', 'sensorIds'], at);
  const preset = parsed(SensorRigPresetSchema, recipe.preset, `${at}.preset`);
  requireThat(equal(preset, recipe.preset), 'unfrozen_preset', `${at}.preset`, 'Supply the fully parsed canonical preset, including all defaults');
  requireThat(Array.isArray(recipe.sensorIds) && recipe.sensorIds.length === preset.sensors.length,
    'invalid_sensor_ids', `${at}.sensorIds`, 'Supply one explicit deterministic ID for each preset slot in order');
  recipe.sensorIds.forEach((id, i) => parsed(EntityIdSchema, id, `${at}.sensorIds.${i}`));
  requireThat(new Set(recipe.sensorIds).size === recipe.sensorIds.length, 'duplicate_sensor', `${at}.sensorIds`, 'Rig sensor IDs must be distinct');
  const sensors = instantiateSensorRig(preset, actor, (_template, index) => recipe.sensorIds[index]);
  requireThat(sensors.some(sensor => sensor.enabled), 'disabled_recipe', at, 'A sensing recipe must declare at least one enabled sensor');
  return sensors;
}
function validateSelections(brief, selections) {
  const labels = briefLabels(brief);
  keys(selections, ['participants', 'sensingIntervention'], 'selections');
  requireThat(Array.isArray(selections.participants) && selections.participants.length === labels.length,
    'participant_coverage', 'participants', 'Cover every exact frozen participant label once');
  const seen = new Set();
  for (const [index, entry] of selections.participants.entries()) {
    const at = `participants.${index}`;
    keys(entry, ['participant', 'baseRecipe', 'controlRecipe', 'rationale', 'limitations'], at);
    requireThat(labels.includes(entry.participant) && !seen.has(entry.participant), 'participant_coverage', `${at}.participant`, 'Unknown or repeated exact brief participant label');
    seen.add(entry.participant);
    text(entry.rationale, `${at}.rationale`);
    requireThat(Array.isArray(entry.limitations), 'invalid_limitations', `${at}.limitations`, 'Expected an array of explicit limitation statements');
    entry.limitations.forEach((value, i) => text(value, `${at}.limitations.${i}`));
    for (const actor of referenceActors()) {
      resolveRecipe(entry.baseRecipe, actor, `${at}.baseRecipe`);
      if (entry.controlRecipe !== null) resolveRecipe(entry.controlRecipe, actor, `${at}.controlRecipe`);
    }
    if (entry.controlRecipe !== null) {
      requireThat(!equal(entry.baseRecipe, entry.controlRecipe), 'redundant_control', `${at}.controlRecipe`, 'Use null for the same declared resolution recipe');
      requireThat(selections.sensingIntervention !== null, 'undeclared_sensing_intervention', `${at}.controlRecipe`, 'Different control sensing requires an explicit brief causal intervention citation');
    }
  }
  if (selections.sensingIntervention !== null) {
    keys(selections.sensingIntervention, ['briefField', 'quote'], 'sensingIntervention');
    const { briefField, quote } = selections.sensingIntervention;
    text(briefField, 'sensingIntervention.briefField'); text(quote, 'sensingIntervention.quote');
    requireThat(briefField === 'controlIntervention' && typeof brief.controlIntervention === 'string' && brief.controlIntervention.includes(quote),
      'invalid_intervention_citation', 'sensingIntervention', 'Citation must quote the exact controlIntervention field; its causal sensing meaning remains an explicit planner assertion, not an automated semantic judgment');
  }
}
function validatePolicy(policy, brief = policy?.brief) {
  keys(policy, ['schema', 'briefId', 'briefDigest', 'brief', 'runtime', 'participants', 'sensingIntervention'], 'policy');
  requireThat(policy.schema === SCHEMA, 'unsupported_policy', 'policy.schema', `Expected ${SCHEMA}`);
  briefLabels(brief);
  requireThat(policy.briefId === brief.id && policy.briefDigest === contentHash(brief) && equal(policy.brief, brief),
    'brief_mismatch', 'policy.briefDigest', 'Policy must bind the entire exact frozen brief record, not only its prose or ID');
  validateSelections(brief, { participants: policy.participants, sensingIntervention: policy.sensingIntervention });
  requireThat(equal(policy.runtime, runtimeIdentity()), 'runtime_mismatch', 'policy.runtime',
    'Canonical sensing source/build/Node pins or reference definitions changed; do not silently re-freeze historical policies');
  return policy;
}

export function makeBriefSensingPolicy(brief, selections) {
  validateSelections(brief, selections);
  const policy = { schema: SCHEMA, briefId: brief.id, briefDigest: contentHash(brief), brief: clone(brief),
    runtime: runtimeIdentity(), participants: clone(selections.participants), sensingIntervention: clone(selections.sensingIntervention) };
  return freeze(policy);
}

/** The file contains the policy itself; its digest is not a self-referential field. */
export function loadBriefSensingPolicy(file, brief) {
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireThat(brief !== undefined, 'missing_brief', 'brief', 'Loading requires the independently frozen brief record');
  validatePolicy(policy, brief);
  return { policy: freeze(policy), digest: sensingPolicyDigest(policy) };
}
export function sensingPolicyDigest(policy) { validatePolicy(policy); return contentHash(policy); }
function variantRecipe(entry, variant) {
  requireThat(variant === 'base' || variant === 'control', 'invalid_variant', 'variant', 'Expected base or control');
  return variant === 'control' && entry.controlRecipe !== null ? entry.controlRecipe : entry.baseRecipe;
}
function carrierActor(actorSpec) {
  const actor = parsed(ActorSpecSchema, actorSpec, 'actorSpec');
  if (actor.dims || !actor.catalogId) return actor;
  const dims = catalogActorDims(actor.catalogId);
  requireThat(dims !== null, 'catalog_dimensions_unavailable', 'actorSpec.dims',
    'Unknown/custom catalog metadata cannot be guessed; author explicit actor dimensions before resolving this sensor recipe');
  return { ...actor, dims };
}
function expectedSensors(policy, label, actorSpec, variant) {
  const entry = policy.participants.find(value => value.participant === label);
  requireThat(entry, 'unknown_participant', 'participant', 'Use an exact frozen brief participant label');
  const actor = carrierActor(actorSpec);
  return resolveRecipe(variantRecipe(entry, variant), actor);
}
export function expectedParticipantSensors(policy, label, actorSpec, variant = 'base') {
  validatePolicy(policy);
  return expectedSensors(policy, label, actorSpec, variant);
}

/** Returns expected arrays for explicit atomic author edits; never mutates program. */
export function validateSensingProgram(program, policy, variant = 'base') {
  const issues = [], expected = [], unavailable = [];
  const issue = (code, at, reason) => issues.push({ code, path: at, reason });
  try {
    validatePolicy(policy);
    requireThat(variant === 'base' || variant === 'control', 'invalid_variant', 'variant', 'Expected base or control');
    parseSituationProgram(program);
    const binding = program.template.extensions?.sensingPolicy;
    keys(binding, ['digest', 'participants'], 'template.extensions.sensingPolicy');
    requireThat(binding.digest === contentHash(policy), 'policy_digest_mismatch', 'template.extensions.sensingPolicy.digest', 'Bind this exact frozen sensing policy digest');
    keys(binding.participants, policy.participants.map(entry => entry.participant), 'template.extensions.sensingPolicy.participants');
    const roles = new Map(program.template.roles.map(role => [role.id, role]));
    const participants = new Set(program.participants.map(entry => entry.roleId)), bound = new Set();
    for (const entry of policy.participants) {
      const at = `template.extensions.sensingPolicy.participants[${JSON.stringify(entry.participant)}]`;
      const ids = binding.participants[entry.participant];
      requireThat(Array.isArray(ids) && ids.length > 0, 'empty_binding', at, 'Bind at least one declared role; group cardinality is not imposed by this policy');
      for (const id of ids) {
        requireThat(typeof id === 'string' && !bound.has(id), 'overlapping_binding', at, 'Each role ID must occur in only one binding');
        bound.add(id);
        if (!roles.has(id) || !participants.has(id)) {
          if (variant === 'base') issue('missing_bound_participant', at, `Role ${JSON.stringify(id)} must exist as both a template role and program participant`);
          unavailable.push({ participant: entry.participant, roleId: id, reason: 'No declared participant in this variant; no sensing evidence is available' });
          continue;
        }
        const role = roles.get(id), sensors = expectedSensors(policy, entry.participant, role.actor, variant);
        expected.push({ participant: entry.participant, roleId: id, sensors, enabledSensorIds: sensors.filter(sensor => sensor.enabled).map(sensor => sensor.id) });
        if (!Array.isArray(role.actor.sensors) || !equal(role.actor.sensors, sensors)) issue('authored_sensor_mismatch', `template.roles[${JSON.stringify(id)}].actor.sensors`, 'Apply the returned expected sensors explicitly in an atomic author edit; authored arrays must include every canonical parsed field');
      }
    }
    for (const role of program.template.roles) if (!bound.has(role.id) && (role.actor.sensors?.length ?? 0) > 0)
      issue('unbound_sensors', `template.roles[${JSON.stringify(role.id)}].actor.sensors`, 'Unbound participants or context roles may not acquire sensors');
  } catch (error) { issues.push(...issuesFrom(error, 'program')); }
  return { valid: issues.length === 0, issues, expected, unavailable, scope: 'Declared instrumentation only; no execution, sensor-pixel, human or fidelity qualification', limitations: [...limitations] };
}

/** Inspect actual native simulation input and trace, not a summarized positive-report list. */
export function validateSensingExecution(program, policy, simulation, variant = 'base') {
  const declaration = validateSensingProgram(program, policy, variant);
  const issues = [...declaration.issues], participants = [], unavailable = [...declaration.unavailable];
  const issue = (code, at, reason) => issues.push({ code, path: at, reason });
  try {
    requireThat(declaration.valid, 'invalid_declaration', 'program', 'Resolve sensing declaration issues before qualifying executed channels');
    requireThat(ownObject(simulation), 'missing_execution', 'simulation', 'Supply the real simulation object with input and trace');
    const input = parseSimScenarioInput(simulation.input), trace = simulation.trace;
    requireThat(equal(input, simulation.input), 'unparsed_execution_input', 'simulation.input', 'Supply the full canonical parsed input returned by the native simulation, not an abbreviated reconstruction');
    requireThat(ownObject(trace) && ownObject(trace.header) && ownObject(trace.ticks), 'missing_trace', 'simulation.trace', 'A full native engine trace is required');
    requireThat(trace.header.source === undefined || trace.header.source === 'sim-engine', 'unsupported_trace', 'simulation.trace.header.source', 'Adapted or replay-only sources cannot attest native sensing execution');
    requireThat(trace.header.inputHash === contentHash(input), 'input_hash_mismatch', 'simulation.trace.header.inputHash', 'Trace must bind the canonical parsed simulation input');
    requireThat(Array.isArray(trace.ticks.t) && trace.ticks.t.length > 0 && trace.ticks.t.every((t, i, times) => Number.isFinite(t) && (i === 0 || t > times[i - 1])),
      'invalid_ticks', 'simulation.trace.ticks.t', 'Expected nonempty, finite, strictly increasing tick times');
    requireThat(trace.ticks.t[0] <= 0, 'missing_initial_sensor_phase', 'simulation.trace.ticks.t',
      'A cropped post-start trace cannot establish initial pre-trigger sensor presence');
    const ticks = trace.ticks.t.length;
    requireThat(ownObject(trace.ticks.actors), 'missing_actor_channels', 'simulation.trace.ticks.actors', 'Real actor channels are required');
    const channels = trace.ticks.sensors ?? {};
    requireThat(ownObject(channels), 'invalid_channels', 'simulation.trace.ticks.sensors', 'Expected canonical sensor channel record');
    const actors = new Map(input.actors.map(actor => [actor.id, actor]));
    requireThat(actors.size === input.actors.length, 'duplicate_actor', 'simulation.input.actors', 'Actor IDs must be unique');
    for (const actor of input.actors) {
      const track = trace.ticks.actors[actor.id];
      requireThat(ownObject(track) && Array.isArray(track.present) && track.present.length === ticks && track.present.every(v => v === 0 || v === 1),
        'invalid_actor_presence', `simulation.trace.ticks.actors[${JSON.stringify(actor.id)}].present`,
        'Every input actor needs a tick-aligned recorded 0/1 presence channel; zero detections cannot establish absence');
      for (const field of ['x', 'y', 'headingRad', 'speedMps']) requireThat(Array.isArray(track[field]) && track[field].length === ticks && track[field].every(Number.isFinite),
        'invalid_actor_track', `simulation.trace.ticks.actors[${JSON.stringify(actor.id)}].${field}`, 'Expected finite tick-aligned native actor state');
    }
    const expectedRoles = new Set(declaration.expected.map(entry => entry.roleId)), expectedKeys = new Set();
    for (const actor of input.actors) if (!expectedRoles.has(actor.id) && (actor.sensors?.length ?? 0) > 0)
      issue('unbound_executed_sensors', `simulation.input.actors[${JSON.stringify(actor.id)}].sensors`, 'An unbound actor acquired lowered sensors');
    for (const entry of declaration.expected) {
      const actor = actors.get(entry.roleId), at = `simulation.input.actors[${JSON.stringify(entry.roleId)}]`;
      const row = { participant: entry.participant, roleId: entry.roleId, declaredSensors: entry.sensors,
        actorExecuted: false, channels: [], qualifiedSensorPixels: false };
      participants.push(row);
      if (!actor || !Object.hasOwn(trace.ticks.actors, entry.roleId)) {
        issue('actor_unavailable', at, 'Bound actor is absent from real input or actor trace; this is unavailable sensing, not successful absence evidence');
        row.channels = entry.sensors.map(sensor => ({ sensorId: sensor.id, enabled: sensor.enabled, availability: 'unavailable', reportedObservations: [] }));
        continue;
      }
      const present = trace.ticks.actors[entry.roleId].present, absentThroughout = present.every(value => value === 0);
      // Native sensing precedes same-tick existence commands; actor tracks are
      // recorded afterward. A despawn at t=0 can legitimately retain a report.
      const presentAtSensorSampling = actor.presentAtStart || present.some((value, index) => index < ticks - 1 && value === 1);
      row.actorExecuted = presentAtSensorSampling;
      row.presence = absentThroughout ? 'recorded-absent-throughout' : 'recorded-present';
      row.observationPhase = 'pre-trigger; reported status may also be latched';
      row.presenceTrackPhase = 'post-trigger';
      if (!presentAtSensorSampling) unavailable.push({ participant: entry.participant, roleId: entry.roleId, reason: 'Observer is absent in every native pre-trigger sensor snapshot' });
      const matchesLowered = equal(actor.sensors ?? [], entry.sensors.map(sensor => lowerSensor(sensor)));
      if (!matchesLowered) issue('lowered_sensor_mismatch', `${at}.sensors`, 'Executed sensors differ from canonical compiler lowering of the explicitly authored recipe');
      const declaredActor = carrierActor(program.template.roles.find(role => role.id === entry.roleId).actor);
      const dims = declaredActor.dims ?? DEFAULT_ACTOR_DIMS[declaredActor.class];
      const matchesDimensions = equal(actor.dims, { l: dims.length, w: dims.width, h: dims.height });
      if (!matchesDimensions) issue('carrier_dimensions_mismatch', `${at}.dims`, 'Executed carrier dimensions differ from the box used to resolve the authored sensing recipe');
      for (const sensor of entry.sensors) {
        const key = sensorChannelKey(entry.roleId, sensor.id), channel = channels[key];
        expectedKeys.add(key);
        const channelPath = `simulation.trace.ticks.sensors[${JSON.stringify(key)}]`;
        const report = { sensorId: sensor.id, enabled: sensor.enabled, availability: 'unavailable', reportedObservations: [] };
        row.channels.push(report);
        if (!presentAtSensorSampling && channel === undefined) {
          report.availability = 'not-executed-recorded-absent';
          continue;
        }
        if (!ownObject(channel) || channel.observer !== entry.roleId || channel.sensorId !== sensor.id || channel.type !== sensor.type || !ownObject(channel.targets)) {
          issue('channel_unavailable', channelPath, 'Missing or inconsistent canonical sensor channel; declaration alone cannot establish execution');
          continue;
        }
        const channelIssuesBefore = issues.length;
        for (const target of actors.keys()) if (target !== entry.roleId && !Object.hasOwn(channel.targets, target))
          issue('missing_sensor_target', `${channelPath}.targets`, 'A native channel must retain all other input actors, including absent or never-detected targets');
        for (const [target, values] of Object.entries(channel.targets)) {
          if (target === entry.roleId || !actors.has(target) || !Object.hasOwn(trace.ticks.actors, target)) issue('unknown_sensor_target', `${channelPath}.targets`, 'Target must be another executed actor');
          if (!ownObject(values)) { issue('invalid_target_track', `${channelPath}.targets`, 'Expected canonical target arrays'); continue; }
          const ranges = { status: v => Object.values(SENSOR_TRACE_STATUS_LEGEND).includes(v), reason: v => Number.isInteger(v) && v >= 0 && v < SENSOR_TRACE_REASON_LEGEND.length,
            confidence: v => Number.isFinite(v) && v >= 0 && v <= 1, rangeM: v => Number.isFinite(v) && v >= 0, lineOfSight: v => v === 0 || v === 1 };
          let validTarget = true;
          for (const [name, accepts] of Object.entries(ranges)) {
            if (!Array.isArray(values[name]) || values[name].length !== ticks || !values[name].every(accepts)) {
              validTarget = false;
              issue('invalid_target_track', `${channelPath}.targets[${JSON.stringify(target)}].${name}`, 'Channel values must follow the canonical legend/range and align with every tick');
            }
          }
          if (validTarget) for (let index = 0; index < ticks; index++) if (values.status[index] >= SENSOR_TRACE_STATUS_LEGEND.degraded) {
            if (!sensor.enabled) issue('disabled_sensor_report', channelPath, 'A disabled sensor cannot report a positive detection');
            else report.reportedObservations.push({ t: trace.ticks.t[index], target, confidence: values.confidence[index], rangeM: values.rangeM[index] });
          }
        }
        if (issues.length === channelIssuesBefore && matchesLowered && matchesDimensions)
          report.availability = presentAtSensorSampling ? sensor.enabled ? 'executed-synthetic-detections' : 'disabled' : 'recorded-absent-observer';
        // Retain reported detections even across an existence transition or
        // latch interval; they are observations, not post-trigger world truth.
      }
    }
    for (const key of Object.keys(channels)) if (!expectedKeys.has(key)) issue('unexpected_sensor_channel', `simulation.trace.ticks.sensors[${JSON.stringify(key)}]`, 'Trace contains an undeclared or unbound sensor channel');
  } catch (error) { issues.push(...issuesFrom(error, 'simulation')); }
  return { valid: issues.length === 0, issues, participants, unavailable,
    qualifiedSensorPixels: false, scope: 'Input-hash-bound synthetic sensor channels only; not proof of execution provenance against forgery, human sensing, absence from zero reports, or calibrated pixels', limitations: [...limitations] };
}
