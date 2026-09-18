// Build a render-spec/v3 for the NVIDIA sensor configuration from the repo's
// own rig preset and materializer, so the submitted spec is what the product
// would submit rather than a hand-typed approximation.
import { writeFileSync } from 'node:fs';

import {
  RenderSpecV3Schema,
  RENDER_SPEC_V3_SCHEMA,
  PRONTO_CHASE_CAMERA_SENSOR_ID,
  sensorRigPreset,
  type SensorRigSensorTemplate,
  type SensorMount,
} from '@simforge-oss/scenario';
import { materializeSensorRigTemplate } from '@simforge-oss/scenario/contracts';

const EGO = process.env.EGO_ACTOR_ID;
if (!EGO) throw new Error('EGO_ACTOR_ID is required');
const SECONDS = Number(process.env.CLIP_SECONDS ?? '10');

/**
 * Uniform resolution scale for the whole rig, so a smaller card can still run
 * all eight sources. Measured on the reference box: engine + map is ~5.25 GiB
 * and each megapixel of attached sensor costs ~278 MiB, so a 10 GiB card needs
 * the rig under roughly 14 Mpx per frame.
 */
const SCALE = Number(process.env.RIG_SCALE ?? '1');
/** CARLA's H.264 encoder needs even dimensions. */
const scaled = (px: number): number => 2 * Math.round((px * SCALE) / 2);

const preset = sensorRigPreset('nvidia-sdg-av');
if (!preset) throw new Error('nvidia-sdg-av preset missing');

/** Ego bounding box, in metres, from the asset catalog entry for its body. */
/** How far above the bodywork a roof-mounted sensor sits. */
const ROOF_CLEARANCE_M = 0.05;

const EGO_DIMS = {
  length: Number(process.env.EGO_LENGTH_M ?? '4.7'),
  width: Number(process.env.EGO_WIDTH_M ?? '1.82'),
  height: Number(process.env.EGO_HEIGHT_M ?? '1.45'),
};

/**
 * Where an anchor sits on the ego box, in the canonical actor frame
 * (+X forward, +Y up, +Z left). Mirrors `anchorPosition` in
 * schema/v2/sensor-rigs.ts, which is module-private.
 */
function anchorPosition(anchor: { longitudinal: string; vertical: string; lateral: string }) {
  return {
    x: anchor.longitudinal === 'front' ? EGO_DIMS.length / 2
      : anchor.longitudinal === 'rear' ? -EGO_DIMS.length / 2 : 0,
    y: anchor.vertical === 'top' ? EGO_DIMS.height
      : anchor.vertical === 'center' ? EGO_DIMS.height / 2 : 0,
    z: anchor.lateral === 'left' ? EGO_DIMS.width / 2
      : anchor.lateral === 'right' ? -EGO_DIMS.width / 2 : 0,
  };
}

/**
 * Preset mounts are anchor-relative: the stored offset is the authored pose
 * minus the anchor position on a reference car. A render source needs an
 * absolute actor-frame mount, so the anchor is re-added against *this* ego's
 * box. Using the offset directly puts every camera inside the bodywork.
 */
function resolveMount(mount: SensorRigSensorTemplate['mount']): SensorMount {
  if ('position' in mount) {
    return { position: mount.position, rotation: mount.rotation ?? {} };
  }
  const base = anchorPosition(mount.anchor);
  const offset = mount.offset ?? { x: 0, y: 0, z: 0 };
  // The preset's vertical offsets are small negatives authored against a sedan,
  // whose roof slopes away from the top anchor. On a box-bodied carrier the roof
  // is flat at full height, so a negative offset puts the camera in the cabin;
  // a roof-anchored sensor is lifted to sit on the roof plane instead.
  const vertical = mount.anchor.vertical === 'top'
    ? Math.max(offset.y, ROOF_CLEARANCE_M)
    : offset.y;
  return {
    position: { x: base.x + offset.x, y: base.y + vertical, z: base.z + offset.z },
    rotation: mount.rotation ?? {},
  };
}

const outputName = (sensorId: string): string => sensorId.replace(/[^A-Za-z0-9_-]/g, '_');

const sources: unknown[] = [];
for (const sensor of preset.sensors) {
  const material = materializeSensorRigTemplate('nvidia-sdg-av', sensor);
  const common = {
    actorId: EGO,
    sensorId: sensor.id,
    outputName: outputName(sensor.id),
    transform: resolveMount(sensor.mount),
  };
  if (material.type === 'dash_camera') {
    sources.push({
      ...common,
      modality: 'rgb',
      attributes: {
        width: scaled(material.widthPx),
        height: scaled(material.heightPx),
        fps: material.updateRateHz,
        horizontalFovDeg: material.horizontalFovDeg,
        nearM: 0.1,
        farM: 300,
      },
    });
  } else if (material.type === 'lidar') {
    sources.push({
      ...common,
      modality: 'lidar',
      attributes: {
        channels: material.channels,
        rangeM: material.rangeM,
        pointsPerSecond: material.pointsPerSecond,
        rotationFrequencyHz: material.rotationFrequencyHz,
        upperFovDeg: material.upperFovDeg,
        lowerFovDeg: material.lowerFovDeg,
        horizontalFovDeg: material.horizontalFovDeg ?? 360,
      },
    });
  }
}

// The ninth source: the presentation-only trailing chase camera, which is what
// makes the sensor views reviewable as a scene.
sources.push({
  actorId: EGO,
  sensorId: PRONTO_CHASE_CAMERA_SENSOR_ID,
  outputName: 'chase_cam_trailing',
  transform: { position: { x: -8, y: 3.2, z: 0 }, rotation: { pitchRad: -0.1745 } },
  modality: 'rgb',
  attributes: { width: scaled(1920), height: scaled(1080), fps: 30, horizontalFovDeg: 90, nearM: 0.1, farM: 400 },
});

const parsed = RenderSpecV3Schema.parse({
  schema: RENDER_SPEC_V3_SCHEMA,
  sources,
  clip: { startSeconds: 0, endSeconds: SECONDS },
  video: { width: 1920, height: 1080, fps: 30, container: 'mp4', codec: 'h264', quality: 'high' },
  artifacts: ['manifest', 'frames', 'sensorArchive', 'video'],
  capabilityIntent: {
    required: ['sensor.rgb', 'sensor.lidar', 'artifact.manifest'],
    preferred: ['artifact.sensor_archive', 'timing.fixed_step'],
    fidelity: 'dataset',
  },
  authoredEnvironment: { weather: 'clear', timeOfDay: 'noon' },
});

const cameras = parsed.sources.filter((source) => source.modality === 'rgb');
const lidars = parsed.sources.filter((source) => source.modality === 'lidar');
const pixelsPerFrame = cameras.reduce(
  (total, source) => total + source.attributes.width * source.attributes.height,
  0,
);
writeFileSync('/tmp/nvidia-render-spec.json', `${JSON.stringify(parsed, null, 2)}\n`);
console.log(JSON.stringify({
  sources: parsed.sources.length,
  cameras: cameras.length,
  lidars: lidars.length,
  pixelsPerFrame,
  resolutions: [...new Set(cameras.map((source) => `${source.attributes.width}x${source.attributes.height}`))],
  clipSeconds: parsed.clip.endSeconds,
}, null, 2));
