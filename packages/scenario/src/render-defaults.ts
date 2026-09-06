/**
 * The authored capture defaults a template carries for its own sensors.
 *
 * Studio sensors are authored with capture configuration (resolution, frame
 * rate, lidar channel count and point rate, radar point rate) that the actor
 * sensor model deliberately does not hold — an `ActorSensor` is the physical
 * device, and capture is a render-time decision. A generator that lowers such
 * sensors carries the authored capture configuration here, once, as a complete
 * `RenderSpecV3` under `extensions[RENDER_DEFAULTS_EXTENSION_KEY]`, so a render
 * created from the template starts from the authored settings and an explicit
 * submission override wins field by field. Consumers read it through
 * `templateRenderDefaults`; a carrier that is present but not a valid render
 * spec is an authoring error, never a silent fallback to renderer defaults.
 */

import { RENDER_SPEC_V3_SCHEMA, RenderSpecV3Schema, type RenderModality, type RenderSourceV3, type RenderSpecV3 } from './render-spec.js';

export const RENDER_DEFAULTS_EXTENSION_KEY = 'simforge.render-defaults' as const;

/** The validated capture defaults on a template, or `undefined` when it carries none. */
export function templateRenderDefaults(
  template: { readonly extensions?: Readonly<Record<string, unknown>> | undefined },
): RenderSpecV3 | undefined {
  const carried = template.extensions?.[RENDER_DEFAULTS_EXTENSION_KEY];
  if (carried === undefined) return undefined;
  const parsed = RenderSpecV3Schema.safeParse(carried);
  if (!parsed.success) {
    throw new Error(
      `extensions["${RENDER_DEFAULTS_EXTENSION_KEY}"] is not a valid ${RENDER_SPEC_V3_SCHEMA} document: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** The default source authored for one actor sensor and modality, if the template carries one. */
export function renderDefaultSource(
  defaults: RenderSpecV3 | undefined,
  actorId: string,
  sensorId: string,
  modality: RenderModality,
): RenderSourceV3 | undefined {
  return defaults?.sources.find(
    (source) => source.actorId === actorId && source.sensorId === sensorId && source.modality === modality,
  );
}
