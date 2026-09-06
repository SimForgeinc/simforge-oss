/** Pinned source observations, never an engine trace or closed-loop execution.
 * sampleNuRecObservations(binding, {tick,tickHz}) returns observedActors,
 * omissions and controlledRoleRequirements. nativeFrame is available only when
 * all controlled roles have no missing state and observed ego is supported.
 * canonicalSceneStateFrameToNuRecFrame(binding, sequence, {tick}) converts only
 * actual canonical emitted state; it never fills gaps from recorded observations.
 */
import { sceneStateSchema } from '@simforge-oss/engine/scene-state';
import { bindNuRecSceneState } from './situation-nurec.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
// Python round(), used by the native service for its integer microsecond clock.
const roundEven = value => { const low = Math.floor(value), fraction = value-low; return fraction === 0.5 ? low + (low % 2) : Math.round(value); };
function clock(binding, {tick,tickHz}) {
  check(binding?.schema === 'simforge.nurec-situation-binding/v1', 'Expected loaded NuRec binding');
  check(Number.isSafeInteger(tick) && tick >= 0 && finite(tickHz) && tickHz > 0, 'Invalid tick/tickHz');
  const timeS = tick/tickHz, elapsedUs = roundEven(timeS*1e6);
  check(Number.isSafeInteger(elapsedUs), 'Invalid source time');
  check(timeS >= binding.envelope.timeS[0] && timeS < binding.envelope.timeS[1], 'Tick outside supported half-open time envelope');
  check(elapsedUs/1e6 < binding.envelope.timeS[1], 'Rounded tick outside source support');
  return {tick,tickHz,timeS,elapsedUs,sourceTimestampUs:binding.background.episode.startTimestampUs+elapsedUs};
}
const angleDelta = (a,b) => ((b-a+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
const lerp = (a,b,f) => a+(b-a)*f;

export function sampleNuRecObservations(binding, request) {
  const time = clock(binding, request), observedActors = [], omissions = [], controlledRoleRequirements = [];
  const participants = new Map(binding.participants.map(p => [p.roleId,p]));
  for (const actor of binding.input.actors) {
    const authority = participants.get(actor.id)?.authority.find(a => time.timeS >= a.startS && time.timeS < a.endS);
    check(authority, 'No authority for actor '+actor.id);
    if (authority.kind !== 'recorded') {
      controlledRoleRequirements.push({roleId:actor.id,authority:authority.kind,requirement:'Actual engine/controller state required; recorded data is not a substitute'});
      continue;
    }
    const trackId = binding.background.actorTracks[actor.id];
    const samples = actor.id === 'ego' ? binding.egoReference?.samples : binding.tracks.actors[trackId]?.samples;
    const points = actor.behavior?.route?.points;
    check(samples?.length && actor.behavior.route.kind === 'timedPolyline' && points.length === samples.length, 'Recorded route/source correspondence lost: '+actor.id);
    const offsetUs = trackId ? binding.background.sourcePatch?.trackTimeOffsetsUs?.[trackId] ?? 0 : 0;
    const sourceTimeS = (time.elapsedUs+offsetUs)/1e6;
    // Use imported episode-relative support. In particular, singleton imports may
    // carry an older capture timestamp but are supported only at their timeS.
    const first = samples[0], last = samples.at(-1);
    if (sourceTimeS < first.timeS || sourceTimeS > last.timeS) {
      omissions.push({roleId:actor.id,reason:'out-of-source-support',sourceTimeS,supportTimeS:[first.timeS,last.timeS]});
      continue;
    }
    let lo = 0, hi = samples.length-1;
    while (lo < hi) { const mid = (lo+hi) >>> 1; if (samples[mid].timeS < sourceTimeS) lo = mid+1; else hi = mid; }
    const right = lo, left = Math.max(0,right-1), a = samples[left], b = samples[right];
    const f = left === right ? 0 : (sourceTimeS-a.timeS)/(b.timeS-a.timeS);
    check([a.timeS,b.timeS,a.headingRad,b.headingRad,a.speedMps,b.speedMps,actor.initial.pose.headingRad].every(finite), 'Invalid pinned observation: '+actor.id);
    const heading = a.headingRad+angleDelta(a.headingRad,b.headingRad)*f + actor.initial.pose.headingRad-first.headingRad;
    const speed = lerp(a.speedMps,b.speedMps,f);
    // Final bound route positions include every composed move; the original
    // source heading/speed channels remain authoritative under those rigid edits.
    const x = lerp(points[left].x,points[right].x,f), z = lerp(points[left].z,points[right].z,f);
    check([x,z,heading,speed].every(finite), 'Invalid observed transform: '+actor.id);
    observedActors.push({id:actor.id,kind:'update',actorClass:actor.kind, dims:structuredClone(actor.dims),
      transform:{position:[x,0,z],rotation:[0,Math.sin(heading/2),0,Math.cos(heading/2)]},yawRad:heading,
      velocity:[speed*Math.cos(heading),0,-speed*Math.sin(heading)],speedMps:speed,
      observation:{kind:'pinned-source-observation',sourceId:actor.id === 'ego' ? 'ego-reference.json' : 'actor-trajectories.json',trackId:trackId ?? null,sourceTimeS,sourceSampleTimestampsUs:[a.sourceTimestampUs,b.sourceTimestampUs],fraction:f,edited:!!binding.background.sourcePatch}});
  }
  const nativeFrame = controlledRoleRequirements.length || !observedActors.some(a => a.id === 'ego') ? null : {
    version:'simforge.scene-state.v1',mapId:binding.source.mapId,tick:time.tick,tickHz:time.tickHz,t:time.timeS,
    provenance:'pinned-source-observation; not engine execution',actors:observedActors,
  };
  return freeze({schema:'simforge.nurec-observations/v1',kind:'pinned-source-observation',qualification:'not-closed-loop',...time,observedActors,omissions,controlledRoleRequirements,nativeFrame});
}

export function canonicalSceneStateFrameToNuRecFrame(binding, sequence, {tick}) {
  const canonical = sceneStateSchema.parse(sequence);
  check(Number.isSafeInteger(tick) && tick >= 0, 'Invalid selected tick');
  const selected = canonical.frames.filter(frame => frame.tick === tick);
  check(selected.length === 1, 'Selected tick must identify exactly one canonical frame');
  const frame = selected[0];
  const time = clock(binding,{tick:frame.tick,tickHz:canonical.tickHz});
  check(Math.abs(frame.t-time.timeS) <= Number.EPSILON*8*Math.max(1,Math.abs(frame.t)), 'Canonical frame time disagrees with native tick clock');
  // Reuse immutable-fork identity/presence checks, not a second actor binding policy.
  const bound = bindNuRecSceneState(binding,{...canonical,frames:[frame]});
  const descriptors = new Map(bound.actors.map(actor => [actor.id,actor]));
  return freeze({version:canonical.version,mapId:binding.source.mapId,tick:frame.tick,tickHz:canonical.tickHz,t:frame.t,
    provenance:'canonical-engine-scene-state',actors:bound.frames[0].actors.map(actor => {
      const {position,rotation,...state} = actor;
      return {...descriptors.get(actor.id),...state,transform:{position,rotation}};
    })});
}
