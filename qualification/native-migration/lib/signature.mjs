/**
 * Trace signature for native-migration qualification.
 *
 * A signature splits one engine trace into the two things the port must
 * reproduce under different rules:
 *
 * - `discrete`: every exact transition — event sequence, spawn/despawn,
 *   lane hand-offs, motion-direction flips, signal phases, collision pairs,
 *   metric pair identities. Compared for equality; a tolerance never excuses a
 *   changed transition.
 * - `numeric`: the per-tick continuous channels. Compared against frozen
 *   tolerances (see tolerances.json) only on ticks where both sides agree the
 *   actor is present.
 *
 * The schema is engine-neutral JSON so a Rust runner can emit the same shape
 * without linking the TypeScript engine.
 */

export const SIGNATURE_SCHEMA = 'simforge.native-migration.signature/v1';

const NUMERIC_CHANNELS = ['x', 'y', 'headingRad', 'speedMps', 'lateralOffsetM', 's'];

function transitions(values, t) {
  const out = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== values[i - 1]) out.push({ t: t[i], from: values[i - 1], to: values[i] });
  }
  return out;
}

function presenceIntervals(present, t) {
  const out = [];
  let open = null;
  for (let i = 0; i < present.length; i += 1) {
    if (present[i] === 1 && open === null) open = t[i];
    if (present[i] !== 1 && open !== null) { out.push({ fromT: open, toT: t[i - 1] }); open = null; }
  }
  if (open !== null) out.push({ fromT: open, toT: t[present.length - 1] });
  return out;
}

/** Deterministic discrete signature; key order is fixed so the JSON is diffable. */
export function discreteSignature(trace, { traceDigest, inputHash }) {
  const t = trace.ticks.t;
  const actors = Object.keys(trace.ticks.actors).sort();
  const header = trace.header;
  return {
    schema: SIGNATURE_SCHEMA,
    engineVersion: header.engineVersion,
    traceVersion: header.traceVersion,
    inputHash,
    traceDigest,
    dt: header.dt,
    clipSeconds: header.clipSeconds,
    warmupSeconds: header.warmupSeconds,
    mapId: header.mapId,
    engineGraphDigest: header.engineGraphDigest,
    topologyDigest: header.topologyDigest,
    tickCount: t.length,
    firstT: t[0] ?? null,
    lastT: t[t.length - 1] ?? null,
    ego: header.ego ?? null,
    metricSubject: header.metricSubject ?? null,
    ambientActorIds: header.ambientActorIds ?? [],
    physics: {
      mode: header.physics?.mode ?? null,
      solver: header.physics?.solver ?? null,
      resolvedProfileDigest: header.physics?.resolvedProfileDigest ?? null,
      actorBackends: header.physics?.actorBackends ?? null,
    },
    operationalConditions: header.operationalConditions ?? null,
    actors: Object.fromEntries(actors.map((id) => {
      const track = trace.ticks.actors[id];
      return [id, {
        presence: presenceIntervals(track.present, t),
        laneTransitions: transitions(track.laneRsl, t),
        motionDirectionTransitions: track.motionDirection ? transitions(track.motionDirection, t) : [],
        downSinceS: track.downSinceS ?? null,
      }];
    })),
    signals: Object.fromEntries(Object.keys(trace.ticks.signals ?? {}).sort().map((id) => [
      id, { initial: trace.ticks.signals[id].phase[0] ?? null, transitions: transitions(trace.ticks.signals[id].phase, t) },
    ])),
    events: trace.events.map((event) => ({ ...event })),
    metrics: {
      collisions: trace.metrics.collisions,
      triggerNeverFired: trace.metrics.triggerNeverFired,
      clippedCriticality: trace.metrics.clippedCriticality,
      ticksSimulated: trace.metrics.ticksSimulated,
      minTTCPair: trace.metrics.minTTC?.pair ?? null,
      minDistancePairs: trace.metrics.minDistance.map((entry) => entry.pair),
      revealToConflictPair: trace.metrics.revealToConflict?.pair ?? null,
    },
  };
}

export function numericSignature(trace) {
  const actors = Object.keys(trace.ticks.actors).sort();
  return {
    schema: SIGNATURE_SCHEMA,
    t: trace.ticks.t,
    channels: NUMERIC_CHANNELS,
    actors: Object.fromEntries(actors.map((id) => {
      const track = trace.ticks.actors[id];
      return [id, {
        present: track.present,
        ...Object.fromEntries(NUMERIC_CHANNELS.map((channel) => [channel, track[channel]])),
      }];
    })),
    metrics: {
      minTTC: trace.metrics.minTTC ? { value: trace.metrics.minTTC.value, t: trace.metrics.minTTC.t } : null,
      minDistance: trace.metrics.minDistance.map((entry) => ({ pair: entry.pair, minDistanceM: entry.minDistanceM, t: entry.t })),
      requiredDecelMax: trace.metrics.requiredDecelMax,
      revealToConflictS: trace.metrics.revealToConflict?.value ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// comparison

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
const canonical = (value) => JSON.stringify(stable(value));

/**
 * Exact comparison of two discrete signatures. Returns the list of mismatched
 * paths; an empty list is a pass. `traceDigest` equality is reported as its
 * own field because it is only required by the same-build replay class.
 */
export function compareDiscrete(reference, candidate) {
  const mismatches = [];
  const check = (path, a, b) => { if (canonical(a) !== canonical(b)) mismatches.push(path); };
  for (const key of ['dt', 'clipSeconds', 'tickCount', 'firstT', 'lastT', 'ego', 'metricSubject', 'ambientActorIds', 'operationalConditions']) {
    check(key, reference[key], candidate[key]);
  }
  check('physics.mode', reference.physics.mode, candidate.physics.mode);
  check('physics.actorBackends', reference.physics.actorBackends, candidate.physics.actorBackends);
  const actorIds = new Set([...Object.keys(reference.actors), ...Object.keys(candidate.actors)]);
  for (const id of [...actorIds].sort()) {
    const a = reference.actors[id];
    const b = candidate.actors[id];
    if (!a || !b) { mismatches.push(`actors.${id}.exists`); continue; }
    for (const key of ['presence', 'laneTransitions', 'motionDirectionTransitions', 'downSinceS']) check(`actors.${id}.${key}`, a[key], b[key]);
  }
  check('signals', reference.signals, candidate.signals);
  if (reference.events.length !== candidate.events.length) mismatches.push('events.length');
  const eventCount = Math.min(reference.events.length, candidate.events.length);
  for (let i = 0; i < eventCount; i += 1) {
    if (canonical(reference.events[i]) !== canonical(candidate.events[i])) { mismatches.push(`events.${i}`); break; }
  }
  for (const key of Object.keys(reference.metrics)) check(`metrics.${key}`, reference.metrics[key], candidate.metrics[key]);
  return {
    pass: mismatches.length === 0,
    mismatches,
    inputHashEqual: reference.inputHash === candidate.inputHash,
    traceDigestEqual: reference.traceDigest === candidate.traceDigest,
    engineVersion: { reference: reference.engineVersion, candidate: candidate.engineVersion },
  };
}

const wrapAngle = (value) => Math.atan2(Math.sin(value), Math.cos(value));

/**
 * Numeric comparison on co-present ticks. `tolerances` maps channel -> max
 * absolute error; metrics use `tolerances.metrics`. Reports max/RMS error and
 * the first tick that exceeds tolerance per channel.
 */
export function compareNumeric(reference, candidate, tolerances) {
  const channels = {};
  let pass = true;
  if (reference.t.length !== candidate.t.length) {
    return { pass: false, reason: 'tick count differs', channels, metrics: {} };
  }
  for (let i = 0; i < reference.t.length; i += 1) {
    if (Math.abs(reference.t[i] - candidate.t[i]) > tolerances.t) {
      return { pass: false, reason: `tick ${i} time differs`, channels, metrics: {} };
    }
  }
  for (const id of Object.keys(reference.actors).sort()) {
    const a = reference.actors[id];
    const b = candidate.actors[id];
    if (!b) { channels[id] = { missing: true }; pass = false; continue; }
    channels[id] = {};
    for (const channel of reference.channels) {
      const tolerance = tolerances.channels[channel];
      let maxAbs = 0; let sumSq = 0; let count = 0; let firstExceed = null;
      for (let i = 0; i < reference.t.length; i += 1) {
        if (a.present[i] !== 1 || b.present[i] !== 1) continue;
        let diff = a[channel][i] - b[channel][i];
        if (channel === 'headingRad') diff = wrapAngle(diff);
        const abs = Math.abs(diff);
        if (abs > maxAbs) maxAbs = abs;
        sumSq += diff * diff; count += 1;
        if (firstExceed === null && abs > tolerance) firstExceed = { tick: i, t: reference.t[i], diff };
      }
      const within = firstExceed === null;
      if (!within) pass = false;
      channels[id][channel] = { count, maxAbs, rms: count ? Math.sqrt(sumSq / count) : 0, tolerance, within, firstExceed };
    }
  }
  const metrics = {};
  const metricCheck = (name, a, b) => {
    if (a === null || b === null || a === undefined || b === undefined) {
      const same = (a ?? null) === (b ?? null);
      metrics[name] = { reference: a ?? null, candidate: b ?? null, within: same };
      if (!same) pass = false;
      return;
    }
    const diff = Math.abs(a - b);
    const within = diff <= tolerances.metrics;
    metrics[name] = { reference: a, candidate: b, diff, within };
    if (!within) pass = false;
  };
  metricCheck('minTTC.value', reference.metrics.minTTC?.value ?? null, candidate.metrics.minTTC?.value ?? null);
  metricCheck('minTTC.t', reference.metrics.minTTC?.t ?? null, candidate.metrics.minTTC?.t ?? null);
  metricCheck('revealToConflictS', reference.metrics.revealToConflictS, candidate.metrics.revealToConflictS);
  reference.metrics.minDistance.forEach((entry, index) => {
    const other = candidate.metrics.minDistance[index];
    metricCheck(`minDistance.${entry.pair.join('/')}.minDistanceM`, entry.minDistanceM, other?.minDistanceM ?? null);
    metricCheck(`minDistance.${entry.pair.join('/')}.t`, entry.t, other?.t ?? null);
  });
  for (const [id, value] of Object.entries(reference.metrics.requiredDecelMax)) {
    metricCheck(`requiredDecelMax.${id}`, value, candidate.metrics.requiredDecelMax?.[id] ?? null);
  }
  return { pass, channels, metrics };
}
