import {
  BUILT_IN_SENSOR_RIGS,
  sensorRigPreset,
  type SensorRigPreset,
} from "@simforge-oss/scenario";

export const PRONTO_SENSOR_RIG: SensorRigPreset = (() => {
  const preset = sensorRigPreset("pronto");
  if (!preset) throw new Error("Missing canonical Pronto sensor rig");
  return preset;
})();

export const EDITOR_SENSOR_RIGS: readonly SensorRigPreset[] = BUILT_IN_SENSOR_RIGS;
