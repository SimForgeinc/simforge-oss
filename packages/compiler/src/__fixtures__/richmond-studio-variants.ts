/**
 * Richmond map-bound documents that exercise every Studio refinement on the
 * real simulation path: authored paint in several spellings, baked parked cars
 * (unsorted, one malformed, one colliding with an authored id) and native
 * ambient traffic.
 */
import { readFileSync } from 'node:fs';

type Template = {
  roles: Array<{ id: string; extensions?: Record<string, unknown> }>;
  extensions?: Record<string, unknown>;
};

export function richmondTemplate(): Template {
  return JSON.parse(readFileSync(new URL('./richmond-map-bound.template.json', import.meta.url), 'utf8')) as Template;
}

export function richmondStudioVariants(): Record<string, Template> {
  const base = richmondTemplate();
  const role = base.roles[0]!;
  const paint = (color: unknown): Template => ({
    ...base,
    roles: [{ ...role, extensions: { ...role.extensions, 'studio.presentation.bodyColor': color } }, ...base.roles.slice(1)],
  });
  const car = (id: string, dx: number, dz: number, heading: number) => ({
    id, stallId: `stall-${id}`, catalogId: 'vehicle.sedan',
    x: 41.444367 + dx, y: 6.65825, z: -134.008232 + dz, headingRad: heading, lengthM: 4.6, widthM: 1.85, heightM: 1.5,
  });
  const parked = (template: Template): Template => ({
    ...template,
    extensions: {
      ...template.extensions,
      'studio.ambientTraffic.parkedCars.v1': {
        baked: [
          car('parked:c', 12, 9, 1.2),
          car('parked:a', -14, 7, 0.3),
          { id: 'parked:broken', stallId: 's', catalogId: 'vehicle.sedan', x: 'nope' },
          car(role.id, 30, 30, 0),
          car('parked:b', 18, -11, 2.9),
        ],
      },
    },
  });
  return {
    plain: base,
    paintRgb: paint('rgb(12, 200, 7)'),
    paintShortHex: paint('#AbC'),
    paintExotic: paint('rgb(,5.0,0x1f)'),
    paintInvalid: paint('rgb(300,0,0)'),
    parked: parked(base),
    parkedPainted: parked(paint('rgb(12, 200, 7)')),
    nativeAmbient: {
      ...parked(base),
      extensions: {
        ...parked(base).extensions,
        'studio.ambientTraffic.provider.v1': 'native',
        'studio.ambientTraffic.profile.v1': { version: 1, preset: 'city', seed: 'studio-refinements', maxActors: 16 },
      },
    },
  };
}
