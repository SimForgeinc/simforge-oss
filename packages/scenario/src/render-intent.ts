import { z } from 'zod-v4';

import { RenderSpecV3Schema } from './render-spec.js';
import { EntityIdSchema } from './schema/v1.js';
import { DashCameraSensorSchema, type ActorSensor, type DashCameraSensor } from './schema/v2/sensors.js';
import { Sha256 } from './sha256.js';
import { canonicalJson } from './canonical-json.js';

export const RENDER_INTENT_V1_SCHEMA = 'simforge.render-intent/v1' as const;

/**
 * The control plane still stores and serves these documents under the
 * pre-rename `uniscenario.` namespace, and the digest that authorizes a render
 * is taken over those exact bytes. Accepting either spelling is what the
 * platform already does on its own wire contracts
 * (`namespaceTolerantLiteral`, render-wire-contracts.ts:90-91); rewriting the
 * tag instead would change the bytes and break the digest.
 */
const namespaceTolerantLiteral = (canonical: string) =>
  z.union([z.literal(canonical), z.literal(canonical.replace(/^simforge\./, 'uniscenario.'))]);

/**
 * A trailing presentation camera authored on the sensor host. It rides outside the
 * measurement rig so a render can ship a drive-along view without restating the rig counts.
 */
export const PRONTO_CHASE_CAMERA_SENSOR_ID = 'chase-cam-trailing' as const;

/**
 * The one trailing chase camera every render carries when the host does not
 * author its own: behind and above the actor, pitched down so the vehicle sits
 * in the lower third with the road ahead. Both engines keep the host's own
 * geometry visible in this view (a rigid rig mount hides it), and the intent
 * store admits a source with this id only when it matches this mount exactly,
 * so the definition is the lineage.
 */
export const PRONTO_CHASE_CAMERA_SENSOR: DashCameraSensor = DashCameraSensorSchema.parse({
  id: PRONTO_CHASE_CAMERA_SENSOR_ID,
  type: 'dash_camera',
  label: 'Trailing chase camera',
  mount: {
    position: { x: -7.5, y: 3.2, z: 0 },
    rotation: { yawRad: 0, pitchRad: -0.24, rollRad: 0 },
  },
  camera: { horizontalFovDeg: 70, verticalFovDeg: 42, aspectRatio: 1.777778, nearM: 0.1, farM: 1_000 },
});

/** Whether an authored sensor list already carries a trailing chase camera. */
export function hasTrailingChaseCamera(sensors: readonly ActorSensor[]): boolean {
  return sensors.some((sensor) => sensor.id === PRONTO_CHASE_CAMERA_SENSOR_ID && sensor.enabled);
}

export const RenderSha256Schema = z.string().regex(
  /^[0-9a-f]{64}$/,
  'must be a lowercase hexadecimal SHA-256 digest',
);

export const RenderIntentIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  'must be a stable 1-128 character identifier',
);

export const RenderIntentAssetSchema = z.strictObject({
  assetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  kind: z.enum(['map', 'catalog', 'texture', 'mesh', 'other']),
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const RenderIntentScenarioRevisionSchema = z.strictObject({
  revisionId: RenderIntentIdSchema,
  scenarioSha256: RenderSha256Schema,
  openScenario: z.strictObject({
    sha256: RenderSha256Schema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  map: z.strictObject({
    mapId: RenderIntentIdSchema,
    revisionId: RenderIntentIdSchema,
    sha256: RenderSha256Schema,
  }),
});

/**
 * Immutable catalog identity for one selected render source's authored host.
 * `sourceId` is the source's unique `outputName`; actor identity remains
 * explicit so sensors mounted on different actors can share one intent.
 *
 * `vehicleAsset` tolerates unknown keys because it may carry renderer-specific
 * catalog provenance, but host selection never depends on those extra keys.
 */
export const RenderSensorSourceHostSchema = z.strictObject({
  sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  actorId: EntityIdSchema,
  vehicleAsset: z.looseObject({
    catalogAssetId: z.string().trim().min(1).max(200),
  }),
});

// Bounds untrusted declaration size and linear validation work, not a GPU
// descriptor table. Garching has 27,879 source-inclusive members; 65,536 leaves
// >2x headroom including the three non-map native assets.
export const RENDER_INTENT_MAX_ASSETS = 65_536;

/**
 * Immutable, renderer-neutral input to every SimForge rendering backend.
 * Transfer URLs and lease data deliberately live in the worker-control claim,
 * so refreshing credentials never changes this document's content hash.
 */
export const RenderIntentV1Schema = z.strictObject({
  schema: namespaceTolerantLiteral(RENDER_INTENT_V1_SCHEMA),
  intentId: RenderIntentIdSchema,
  executionPackage: z.strictObject({
    id: RenderIntentIdSchema,
    sourceInputDigest: RenderSha256Schema,
  }),
  scenarioRevision: RenderIntentScenarioRevisionSchema,
  sensorHosts: z.array(RenderSensorSourceHostSchema).min(1).max(64),
  renderSpec: RenderSpecV3Schema,
  /** Native texture representation, pinned in the intent hash; never a viewer default. */
  renderTextures: z.enum(['uastc-full', 'bc7-512']).optional(),
  /** Native admission estimate, not a driver-enforced VRAM ceiling. */
  nativeVramBudgetBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  /** Assumed device capacity for demand-derived admission when no explicit ceiling is set. */
  nativeVramCapacityBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  assets: z.array(RenderIntentAssetSchema).max(RENDER_INTENT_MAX_ASSETS),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).check((ctx) => {
  const ids = new Set<string>();
  ctx.value.assets.forEach((asset, index) => {
    if (ids.has(asset.assetId)) {
      ctx.issues.push({
        code: 'custom',
        path: ['assets', index, 'assetId'],
        message: `duplicate assetId "${asset.assetId}"`,
        input: asset.assetId,
      });
    }
    ids.add(asset.assetId);
  });
  const sourcesById = new Map(ctx.value.renderSpec.sources.map((source) => [source.outputName, source]));
  const hostSourceIds = new Set<string>();
  ctx.value.sensorHosts.forEach((host, index) => {
    if (hostSourceIds.has(host.sourceId)) {
      ctx.issues.push({
        code: 'custom',
        path: ['sensorHosts', index, 'sourceId'],
        message: `duplicate sensor host sourceId "${host.sourceId}"`,
        input: host.sourceId,
      });
    }
    hostSourceIds.add(host.sourceId);
    const source = sourcesById.get(host.sourceId);
    if (!source) {
      ctx.issues.push({
        code: 'custom',
        path: ['sensorHosts', index, 'sourceId'],
        message: `sensor host sourceId "${host.sourceId}" does not name a render source`,
        input: host.sourceId,
      });
    } else if (source.actorId !== host.actorId) {
      ctx.issues.push({
        code: 'custom',
        path: ['sensorHosts', index, 'actorId'],
        message: `sensor host actorId must match render source "${host.sourceId}"`,
        input: host.actorId,
      });
    }
  });
  ctx.value.renderSpec.sources.forEach((source, index) => {
    if (!hostSourceIds.has(source.outputName)) {
      ctx.issues.push({
        code: 'custom',
        path: ['renderSpec', 'sources', index, 'outputName'],
        message: `render source "${source.outputName}" has no sensor host mapping`,
        input: source.outputName,
      });
    }
  });
});

export type RenderIntentAsset = z.infer<typeof RenderIntentAssetSchema>;
export type RenderIntentScenarioRevision = z.infer<typeof RenderIntentScenarioRevisionSchema>;
export type RenderSensorSourceHost = z.infer<typeof RenderSensorSourceHostSchema>;
export type RenderIntentV1 = z.infer<typeof RenderIntentV1Schema>;

export function parseRenderIntent(value: unknown): RenderIntentV1 {
  return RenderIntentV1Schema.parse(value);
}

function compareSourceId(
  left: { outputName?: string; sourceId?: string },
  right: { outputName?: string; sourceId?: string },
): number {
  return (left.outputName ?? left.sourceId ?? '').localeCompare(right.outputName ?? right.sourceId ?? '');
}

export function canonicalizeRenderIntent(intent: RenderIntentV1): string {
  const parsed = RenderIntentV1Schema.parse(intent);
  return canonicalJson({
    ...parsed,
    sensorHosts: [...parsed.sensorHosts].sort(compareSourceId),
    renderSpec: {
      ...parsed.renderSpec,
      sources: [...parsed.renderSpec.sources].sort(compareSourceId),
    },
  });
}

/**
 * THE render-intent content hash. Every layer — submit, claim fencing, worker
 * verification, CLI — must call this one implementation; a second copy is how
 * `render_intent_digest_mismatch` incidents happen. Pure (no platform crypto)
 * so browser and server bundles hash identically.
 */
export function hashRenderIntent(intent: RenderIntentV1): string {
  return new Sha256()
    .update(new TextEncoder().encode(canonicalizeRenderIntent(intent)))
    .digestHex();
}
