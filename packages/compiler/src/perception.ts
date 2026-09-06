/**
 * Authored sensor → engine sensor, field for field.
 *
 * The native compiler performs this same lowering when it materialises; the
 * TypeScript copy exists so authoring tools can compare an executed input's
 * `actor.sensors` against the canonical lowering of a frozen recipe without a
 * compile. Atmosphere and map-divergence lowering are native-only.
 */

import type { SimSensor } from '@simforge-oss/engine';
import { sensorAperture, type ActorSensor } from '@simforge-oss/scenario';

export function lowerSensor(sensor: ActorSensor): SimSensor {
  const aperture = sensorAperture(sensor);
  return {
    id: sensor.id,
    type: sensor.type,
    ...(sensor.label === undefined ? {} : { label: sensor.label }),
    enabled: sensor.enabled,
    mount: {
      position: { ...sensor.mount.position },
      rotation: { ...sensor.mount.rotation },
    },
    aperture: { ...aperture },
    ...(sensor.type === 'dash_camera' ? { aspectRatio: sensor.camera.aspectRatio } : {}),
    detection: {
      contrastThreshold: sensor.detection.contrastThreshold,
      minAngularSizeRad: sensor.detection.minAngularSizeRad,
      minIlluminationFrac: sensor.detection.minIlluminationFrac,
      detectConfidence: sensor.detection.detectConfidence,
      degradedConfidence: sensor.detection.degradedConfidence,
      sensitivity: { ...sensor.detection.sensitivity },
      latchS: sensor.detection.latchS,
    },
  } as SimSensor;
}
