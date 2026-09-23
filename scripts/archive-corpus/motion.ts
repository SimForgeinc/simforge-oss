/**
 * The archive corpus motion reference (see `archive-corpus.ts`): computed from
 * stored bytes alone, so readers are checked against an independent value.
 * `native/crates/simforge-core/tests/archive_corpus.rs` computes the same
 * document in Rust; both hash it with SimForge canonical JSON.
 */

export const ARCHIVE_MOTION_SCHEMA = 'simforge.archive-motion/v1';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Rust `simforge_core::math::quantize`: half away from zero, -0 → 0. */
export function quantize(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** decimals;
  const scaled = v * f;
  const r = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return r / f + 0;
}

/**
 * The motion a replay must reproduce: tick times and, per actor, the world
 * pose on the trace grid (position 4 dp, heading 6 dp), `null` where the
 * actor is absent. Rust computes the same document from the upgraded trace
 * and from the render timeline (`tests/archive_corpus.rs`).
 */
export function motionOf(trace: { ticks: { t: number[]; actors: Record<string, Record<string, unknown>> } }): Json {
  const actors: Record<string, Json> = {};
  for (const id of Object.keys(trace.ticks.actors).sort()) {
    const track = trace.ticks.actors[id] as { present: number[]; x: number[]; y: number[]; headingRad: number[] };
    const at = (values: number[], d: number) => values.map((v, i) => (track.present[i] === 1 ? quantize(v, d) : null));
    actors[id] = { present: track.present.map((p) => (p === 1 ? 1 : 0)), x: at(track.x, 4), y: at(track.y, 4), headingRad: at(track.headingRad, 6) };
  }
  return { schema: ARCHIVE_MOTION_SCHEMA, t: trace.ticks.t.map((t) => quantize(t, 6)), actors };
}

export function timelineMotionOf(timeline: { t: number[]; actors: { id: string; track: { present: number[]; x: number[]; y: number[]; headingRad: number[] } }[] }): Json {
  const actors: Record<string, Json> = {};
  for (const actor of [...timeline.actors].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const tr = actor.track;
    const at = (values: number[]) => values.map((v, i) => (tr.present[i] === 1 ? v + 0 : null));
    actors[actor.id] = { present: tr.present.map((p) => (p === 1 ? 1 : 0)), x: at(tr.x), y: at(tr.y), headingRad: at(tr.headingRad) };
  }
  return { schema: ARCHIVE_MOTION_SCHEMA, t: timeline.t.map((t) => t + 0), actors };
}

