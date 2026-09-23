import { z } from 'zod';

import { cameraProfileCapabilities, type RenderIntentV1 } from '@simforge-oss/scenario';

import { CAMERA_PROFILE_NOT_DECLARED_STATUS, type RenderArtifactManifest } from './artifacts.js';

export const ENGINE_CAPABILITIES_V1_SCHEMA = 'simforge.render-engine-capabilities/v1' as const;

export const EngineCapabilitySchema = z.enum([
  'openscenario.1_4',
  'timing.fixed_step',
  'environment.authored',
  'sensor.rgb',
  'sensor.depth',
  'sensor.semantic',
  'sensor.instance',
  'sensor.lidar',
  'sensor.radar',
  'artifact.video',
  'artifact.frames',
  'artifact.sensor_archive',
  'artifact.sensor_video',
  'artifact.manifest',
  'artifact.trace',
  'artifact.annotations',
  'map.static_semantics',
  'control.native',
  'divergence.classified',
  'camera.projection.pinhole',
  'camera.projection.brown_conrady',
  'camera.projection.kannala_brandt',
  'camera.shutter.global',
  'camera.shutter.rolling',
  'camera.output.raw',
  'camera.output.linear_rgb',
  'camera.output.processed_rgb',
  'camera.noise.ptc',
  'camera.reported-calibration-override',
  'full-mount-rotation',
]);

export const EngineCapabilityApproximationSchema = z.strictObject({
  capability: z.literal('full-mount-rotation'),
  support: z.literal('approximated'),
  reason: z.string().min(1),
});

export const EngineCapabilityFeaturesSchema = z.strictObject({
  'full-mount-rotation': z.strictObject({
    support: z.literal('supported'),
    evidenceTier: z.enum(['declared', 'integrated', 'exercised', 'qualified']),
    note: z.string().min(1).optional(),
  }),
});

export const EngineCapabilityDeclarationSchema = z.strictObject({
  schema: z.literal(ENGINE_CAPABILITIES_V1_SCHEMA),
  engineId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  engineVersion: z.string().min(1).max(128),
  backend: z.enum(['browser', 'carla', 'native']),
  protocolVersion: z.literal(1),
  capabilities: z.array(EngineCapabilitySchema).min(1).max(32),
  features: EngineCapabilityFeaturesSchema.optional(),
  approximations: z.array(EngineCapabilityApproximationSchema).max(32).optional(),
  modalities: z.array(z.enum(['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'])).min(1).max(6),
  limits: z.strictObject({
    maxSimultaneousSensors: z.number().int().positive().max(1024),
    maxWidth: z.number().int().positive().max(32768),
    maxHeight: z.number().int().positive().max(32768),
    maxFramesPerSecond: z.number().int().positive().max(1000),
  }),
  requiresGpu: z.boolean(),
}).check((ctx) => {
  for (const [field, values] of [
    ['capabilities', ctx.value.capabilities],
    ['modalities', ctx.value.modalities],
  ] as const) {
    if (new Set(values).size !== values.length) {
      ctx.issues.push({ code: 'custom', path: [field], message: `${field} must not contain duplicates`, input: values });
    }
  }
});

export type EngineCapability = z.infer<typeof EngineCapabilitySchema>;
export type EngineCapabilityDeclaration = z.infer<typeof EngineCapabilityDeclarationSchema>;

export class UnsupportedRenderIntentError extends Error {
  readonly code = 'unsupported_render_intent';
  constructor(readonly reasons: readonly string[]) {
    super(`engine cannot execute render intent: ${reasons.join('; ')}`);
    this.name = 'UnsupportedRenderIntentError';
  }
}

export type EngineSupportResolution = Pick<RenderArtifactManifest, 'effectiveConfiguration' | 'warnings'>;

export function assertEngineSupportsIntent(
  declaration: EngineCapabilityDeclaration,
  intent: RenderIntentV1,
): EngineSupportResolution {
  const reasons: string[] = [];
  const spec = intent.renderSpec;
  if (spec.sources.length > declaration.limits.maxSimultaneousSensors) {
    reasons.push(`sensor count ${spec.sources.length} exceeds ${declaration.limits.maxSimultaneousSensors}`);
  }
  const modalities = new Set(declaration.modalities);
  for (const source of spec.sources) {
    if (!modalities.has(source.modality)) reasons.push(`unsupported modality ${source.modality}`);
  }
  if (spec.video) {
    if (spec.video.width > declaration.limits.maxWidth || spec.video.height > declaration.limits.maxHeight) {
      reasons.push(`video dimensions ${spec.video.width}x${spec.video.height} exceed engine limits`);
    }
    if (spec.video.fps > declaration.limits.maxFramesPerSecond) {
      reasons.push(`video frame rate ${spec.video.fps} exceeds engine limit`);
    }
  }
  const capabilities = new Set<string>(declaration.capabilities);
  for (const required of spec.capabilityIntent.required) {
    if (required.startsWith('camera.projection.')) continue;
    if (!capabilities.has(required)) reasons.push(`missing capability ${required}`);
  }
  for (const source of spec.sources) {
    if (source.modality === 'lidar' || source.modality === 'radar') continue;
    if (source.attributes.profileSource !== 'authored') continue;
    for (const required of cameraProfileCapabilities(source.attributes.cameraProfile)) {
      if (!required.startsWith('camera.projection.') && !capabilities.has(required)) {
        reasons.push(`missing capability ${required}`);
      }
    }
  }
  for (const artifact of spec.artifacts) {
    const capability = artifact === 'sensorArchive' ? 'artifact.sensor_archive' : `artifact.${artifact}`;
    if (!capabilities.has(capability)) reasons.push(`missing capability ${capability}`);
  }
  if (reasons.length > 0) throw new UnsupportedRenderIntentError([...new Set(reasons)]);
  const cameraProfiles = declaration.capabilities.some((capability) => capability.startsWith('camera.'))
    ? []
    : spec.sources.flatMap((source) =>
      source.modality !== 'lidar' && source.modality !== 'radar' && source.attributes.profileSource === 'default'
        ? [{
            actorId: source.actorId,
            sensorId: source.sensorId,
            outputName: source.outputName,
            profileSource: source.attributes.profileSource,
            status: CAMERA_PROFILE_NOT_DECLARED_STATUS,
          }]
        : []);
  return {
    ...(cameraProfiles.length > 0 ? { effectiveConfiguration: { cameraProfiles } } : {}),
    warnings: cameraProfiles.map((profile) => ({
      code: 'camera_profile_not_declared_by_engine',
      message: `${profile.status}: ${profile.actorId}/${profile.sensorId}`,
    })),
  };
}
