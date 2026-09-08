#!/usr/bin/env node
/**
 * simforge-eval-rig — generate a renderer rig document from an authored sensor
 * rig preset, for the episode runner's `bevy:<rig.json>` frame source.
 *
 *   simforge-eval-rig --preset alpamayo-4cam --scene scene.json --out rig.json
 *
 * A rig is defined exactly once, in `@simforge-oss/scenario`
 * (`sensor-rigs.ts`): sensor ids, vehicle-anchored mounts, FOV and the render
 * size that matches the model processor's max pixels. This command resolves
 * that preset against the ego's box and emits the renderer's ServiceCamera
 * list; it never restates a camera pose.
 *
 * Cameras are emitted with a rigid `attach`, so the render service re-resolves
 * eye/target from the ego's scene-state transform on EVERY render and excludes
 * the ego's own body from its cameras. Combined with the live scene-state
 * exporter, that is what makes the frames the model sees a function of what
 * the policy just did — no per-decision camera math, and no static eye/target
 * that would silently keep pointing at the start pose.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ALPAMAYO_CAMERA_INDEX,
  ALPAMAYO_RENDER_HEIGHT,
  ALPAMAYO_RENDER_WIDTH,
  BUILT_IN_SENSOR_RIGS,
  resolveSensorRigMount,
  sensorRigPreset,
} from '@simforge-oss/scenario';

interface Flags {
  preset?: string;
  scene?: string;
  out?: string;
  ego: string;
  dims: { length: number; width: number; height: number };
  size?: { width: number; height: number };
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { ego: 'ego', dims: { length: 4.7, width: 1.9, height: 1.45 } };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    switch (arg) {
      case '--preset': flags.preset = value(); break;
      case '--scene': flags.scene = value(); break;
      case '--out': flags.out = value(); break;
      case '--ego': flags.ego = value(); break;
      case '--actor-dims': {
        const [length, width, height] = value().split(',').map(Number);
        if (![length, width, height].every((component) => Number.isFinite(component) && component! > 0)) {
          throw new Error('--actor-dims wants three positive numbers: length,width,height');
        }
        flags.dims = { length: length!, width: width!, height: height! };
        break;
      }
      case '--size': {
        const [width, height] = value().split('x').map(Number);
        if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('--size wants <width>x<height>');
        flags.size = { width: width!, height: height! };
        break;
      }
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
if (!flags.preset) {
  process.stderr.write(
    'usage: simforge-eval-rig --preset <rig id> --scene <scene.json> [--out rig.json] [--ego <actorId>] ' +
      '[--actor-dims l,w,h] [--size WxH]\n' +
      `known rigs: ${BUILT_IN_SENSOR_RIGS.map((rig) => rig.id).join(', ')}\n`,
  );
  process.exit(2);
}

const preset = sensorRigPreset(flags.preset);
if (!preset) {
  process.stderr.write(`unknown sensor rig preset ${flags.preset}\n`);
  process.exit(2);
}

const cameraIndex = ALPAMAYO_CAMERA_INDEX as Readonly<Record<string, number>>;
const cameras = preset.sensors
  // `dash_camera` is the camera member of the authored sensor union; lidar and
  // radar templates in a preset are not rendered by a camera rig.
  .filter((sensor) => sensor.type === 'dash_camera')
  .map((sensor) => {
    const mount = resolveSensorRigMount(sensor.mount, { class: 'car', dims: flags.dims });
    // The authored camera carries FOV and aspect, not a pixel size: the render
    // size is the model's (512x384 = the processor's max pixels) unless asked.
    const width = flags.size?.width ?? ALPAMAYO_RENDER_WIDTH;
    const height = flags.size?.height ?? ALPAMAYO_RENDER_HEIGHT;
    return {
      sensorId: sensor.id,
      width,
      height,
      fovDeg: sensor.camera.verticalFovDeg,
      // Ignored while `attach` is present, but the field is required by the
      // service's camera schema.
      eye: [0, 0, 0],
      target: [1, 0, 0],
      attach: {
        actorId: flags.ego,
        offsetM: [mount.position.x, mount.position.y, mount.position.z],
        yawDeg: (mount.rotation.yawRad * 180) / Math.PI,
        pitchDeg: (mount.rotation.pitchRad * 180) / Math.PI,
        rollDeg: (mount.rotation.rollRad * 180) / Math.PI,
        lookAtActor: false,
      },
      /** Model camera index 0..6 when this sensor is an Alpamayo rig camera. */
      modelCameraId: cameraIndex[sensor.id] ?? null,
    };
  });

if (cameras.length === 0) {
  process.stderr.write(`preset ${preset.id} declares no cameras\n`);
  process.exit(2);
}

const scene = flags.scene
  ? (JSON.parse(await readFile(flags.scene, 'utf8')) as unknown)
  : null;
if (scene === null) {
  process.stderr.write(
    '--scene is required: the renderer needs the map/tile scene document to render, and it is never synthesized\n',
  );
  process.exit(2);
}

const document = {
  schema: 'simforge.render-rig/v1',
  rigId: preset.id,
  rigName: preset.name,
  scene,
  passes: ['rgb'],
  cameras,
};

const outPath = flags.out ?? `${preset.id}.rig.json`;
await writeFile(path.resolve(outPath), `${JSON.stringify(document, null, 1)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify({
    rigId: preset.id,
    out: path.resolve(outPath),
    cameras: cameras.map((camera) => ({ sensorId: camera.sensorId, modelCameraId: camera.modelCameraId })),
  })}\n`,
);
