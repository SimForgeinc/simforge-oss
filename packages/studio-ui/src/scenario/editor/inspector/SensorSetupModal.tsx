"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Plus, Radar, Scan, X } from "lucide-react";
import {
  defaultDashCamera,
  defaultLidar,
  defaultRadar,
  instantiateSensorRig,
  resolveSensorMountPreset,
  sensorAperture,
  type ActiveSensorField,
  type ActorSensor,
  type ActorSpec,
  type DashCameraSensor,
  type SensorMount,
} from "@simforge-oss/scenario";
import type { EditorDocument } from "@simforge-oss/editor";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { SensorCoverageDiagram } from "./SensorCoverageDiagram";
import { EDITOR_SENSOR_RIGS, PRONTO_SENSOR_RIG } from "./sensor-rig-presets";
import {
  appliedRigPreset,
  clamp,
  deg,
  DEG_TO_RAD,
  fovPresetsFor,
  matchAimPreset,
  modalityLabel,
  mountPresetFor,
  SENSOR_AIM_PRESETS,
  SENSOR_MOUNT_PRESETS,
  sensorCounts,
  sensorCountSummary,
  sensorName,
  type SensorModality,
} from "./sensor-presentation";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./SensorSetupModal.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * The sensor workbench.
 *
 * Sensor authoring used to live in the 192px actor rail, where a nine-sensor
 * rig became nine accordions of eleven numeric fields and the "Add dash camera"
 * button was clipped mid-word. Configuration moved here, to a surface wide
 * enough to show the vehicle plan beside the controls; the rail keeps only the
 * summary and the enable switches.
 *
 * Two rules shape the interaction. Picking a rig is one click, not a dropdown
 * plus an Apply button, because it is a single undoable command. And every
 * geometric control leads with named choices — roof, windscreen, forward, wide
 * — with the raw numbers underneath for the calibration cases that need them.
 */
export function SensorSetupModal({
  actor,
  document: editorDocument,
  label,
  onClose,
  roleId,
}: {
  actor: ActorSpec;
  document: EditorDocument;
  label: string;
  onClose: () => void;
  roleId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const sensors: readonly ActorSensor[] = actor.sensors;
  const counts = sensorCounts(sensors);
  const rig = useMemo(
    () => appliedRigPreset(sensors, actor, EDITOR_SENSOR_RIGS),
    [actor, sensors],
  );
  const selected = sensors.find((sensor) => sensor.id === selectedId) ?? null;
  const dims = actor.dims ?? { length: 4.8, width: 1.9, height: 1.5 };

  function add(modality: SensorModality) {
    setError(null);
    try {
      const sensor = modality === "dash_camera"
        ? defaultDashCamera(actor)
        : modality === "lidar"
          ? defaultLidar(actor)
          : defaultRadar(actor);
      editorDocument.addActorSensor(roleId, sensor);
      setSelectedId(sensor.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${modalityLabel(modality)} could not be added.`);
    }
  }

  if (!mounted) return null;
  return createPortal(
    <div
      aria-label={`Sensors on ${label}`}
      aria-modal="true"
      {...stylex.props(styles.fixedGridCentered)}
      data-testid="sensor-setup-modal"
      role="dialog"
    >
      <button
        aria-label="Close sensor setup"
        {...stylex.props(styles.absInset0)}
        onClick={onClose}
        type="button"
      />
      <div {...stylex.props(styles.relFlexCol)}>
        <header {...stylex.props(styles.relFlexBetween)}>
          <span aria-hidden {...stylex.props(styles.abs)} />
          <div {...stylex.props(styles.narrowable)}>
            <p {...stylex.props(styles.capsMonoMicro)}>Sensors</p>
            <h2 {...stylex.props(styles.lgInkExtrabold)}>
              {label}
            </h2>
            <p {...stylex.props(styles.xsMuted)}>
              {counts.total === 0
                ? "A vehicle with sensors records the scenario. Fit a rig, or add one sensor."
                : `${sensorCountSummary(counts)}${rig ? ` · ${rig.name}` : ""} · this vehicle records the scenario`}
            </p>
          </div>
          <button
            aria-label="Close sensor setup"
            {...stylex.props(styles.gridCenteredTight)}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className={stylex.props(styles.size4).className} />
          </button>
        </header>

        <div {...stylex.props(styles.gridFillClip)}>
          <div {...stylex.props(styles.ruleBScrollYShrinkable)}>
            <section aria-labelledby="sensor-rig-heading" {...stylex.props(styles.stackSm)}>
              <h3 {...stylex.props(styles.capsMonoMicro2)} id="sensor-rig-heading">
                Production rigs
              </h3>
              {EDITOR_SENSOR_RIGS.map((preset) => {
                const applied = rig?.id === preset.id;
                const presetCounts = sensorCounts(preset.sensors);
                return (
                  <button
                    aria-label={`Fit ${preset.name}`}
                    aria-pressed={applied}
                    className={stylex.props(applied ? styles.flexCenterBordered : styles.flexCenterBordered2, motionStyles.editorMotion).className}
                    key={preset.id}
                    onClick={() => {
                      setError(null);
                      try {
                        editorDocument.replaceActorSensors(
                          roleId,
                          instantiateSensorRig(
                            preset,
                            actor,
                            preset.id === PRONTO_SENSOR_RIG.id
                              ? (template) => template.id
                              : undefined,
                          ),
                        );
                        setSelectedId(null);
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : "The rig could not be fitted.");
                      }
                    }}
                    title={preset.description}
                    type="button"
                  >
                    <span {...stylex.props(styles.fillNarrowable)}>
                      <span {...stylex.props(styles.blockXsInk)}>{preset.name}</span>
                      <span {...stylex.props(styles.blockMicroMuted)}>
                        {sensorCountSummary(presetCounts)}
                      </span>
                    </span>
                    {applied ? (
                      <span {...stylex.props(styles.tightCapsMono)}>
                        Fitted
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </section>

            <section aria-labelledby="sensor-add-heading" {...stylex.props(styles.stackSm, styles.stackedXl)}>
              <h3 {...stylex.props(styles.capsMonoMicro2)} id="sensor-add-heading">
                Add one sensor
              </h3>
              <div {...stylex.props(styles.gridCols3Gap15)}>
                <AddButton
                  icon={Camera}
                  label="Camera"
                  onClick={() => add("dash_camera")}
                  title="Add a camera"
                />
                <AddButton icon={Scan} label="LiDAR" onClick={() => add("lidar")} title="Add a roof LiDAR" />
                <AddButton icon={Radar} label="Radar" onClick={() => add("radar")} title="Add a bumper radar" />
              </div>
              {error ? (
                <p {...stylex.props(styles.microDanger)} role="alert">{error}</p>
              ) : null}
            </section>

            <section aria-labelledby="sensor-list-heading" {...stylex.props(styles.stackSm, styles.stackedXl)}>
              <h3 {...stylex.props(styles.capsMonoMicro2)} id="sensor-list-heading">
                Fitted{counts.total ? ` · ${counts.total}` : ""}
              </h3>
              {sensors.length === 0 ? (
                <p {...stylex.props(styles.xsMuted2)}>Nothing fitted yet.</p>
              ) : (
                sensors.map((sensor) => (
                  <SensorListRow
                    key={sensor.id}
                    document={editorDocument}
                    onSelect={() => setSelectedId(sensor.id)}
                    roleId={roleId}
                    selected={sensor.id === selectedId}
                    sensor={sensor}
                  />
                ))
              )}
            </section>
          </div>

          <div {...stylex.props(styles.flexColScrollY)}>
            <div {...stylex.props(styles.gridCenteredTight2)}>
              {sensors.length === 0 ? (
                <p {...stylex.props(styles.xsMutedCenterText)}>
                  Coverage appears here once this vehicle carries a sensor.
                </p>
              ) : (
                <SensorCoverageDiagram
                  dims={dims}
                  onSelect={setSelectedId}
                  selectedId={selectedId}
                  sensors={sensors}
                />
              )}
            </div>

            {selected ? (
              <SensorEditor
                actor={actor}
                document={editorDocument}
                key={selected.id}
                roleId={roleId}
                sensor={selected}
              />
            ) : sensors.length > 0 ? (
              <p {...stylex.props(styles.xsMuted3)}>
                Select a sensor — in the list or on the plan — to place and aim it.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    window.document.body,
  );
}

function AddButton({
  disabled,
  icon: Icon,
  label,
  onClick,
  title,
}: {
  disabled?: boolean;
  icon: typeof Camera;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      aria-label={`Add ${label}`}
      className={stylex.props(styles.flexColCenter, motionStyles.editorMotion).className}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      <span {...stylex.props(styles.rel)}>
        <Icon aria-hidden="true" className={stylex.props(styles.size4).className} />
        <Plus aria-hidden="true" className={stylex.props(styles.absAccent).className} />
      </span>
      {label}
    </button>
  );
}

function SensorListRow({
  document: editorDocument,
  onSelect,
  roleId,
  selected,
  sensor,
}: {
  document: EditorDocument;
  onSelect: () => void;
  roleId: string;
  selected: boolean;
  sensor: ActorSensor;
}) {
  const aperture = sensorAperture(sensor);
  const name = sensorName(sensor);
  return (
    <div
      {...stylex.props(selected ? styles.flexCenterBordered3 : styles.flexCenterBordered4)}
      data-sensor-id={sensor.id}
    >
      <button
        aria-label={`Configure ${name}`}
        {...stylex.props(styles.fillNarrowableLeftText)}
        onClick={onSelect}
        type="button"
      >
        <span {...stylex.props(styles.blockXsInk2)}>{name}</span>
        <span {...stylex.props(styles.blockMonoMicro)}>
          {modalityLabel(sensor.type)} · {Math.round(aperture.horizontalFovDeg)}° · {Math.round(aperture.farM)} m
        </span>
      </button>
      <Switch
        aria-label={`${name} (${sensor.id}) enabled`}
        checked={sensor.enabled}
        onCheckedChange={(enabled) => replaceSensor(editorDocument, roleId, sensor, { enabled })}
      />
      <button
        aria-label={`Remove ${name} (${sensor.id})`}
        className={stylex.props(styles.muted, motionStyles.editorMotion).className}
        onClick={() => editorDocument.removeActorSensor(roleId, sensor.id)}
        title={`Remove ${name}`}
        type="button"
      >
        <X aria-hidden="true" className={stylex.props(styles.size35).className} />
      </button>
    </div>
  );
}

function SensorEditor({
  actor,
  document: editorDocument,
  roleId,
  sensor,
}: {
  actor: ActorSpec;
  document: EditorDocument;
  roleId: string;
  sensor: ActorSensor;
}) {
  const [showNumbers, setShowNumbers] = useState(false);
  const aperture = sensorAperture(sensor);
  const mountPreset = mountPresetFor(sensor, actor);
  const aimPreset = matchAimPreset(sensor.mount.rotation.yawRad);
  const name = sensorName(sensor);

  return (
    <div {...stylex.props(styles.mt4StackXl)}>
      <label {...stylex.props(styles.block)}>
        <span {...stylex.props(styles.capsMonoMicro2)}>Name</span>
        <Input
          aria-label={`Name for ${modalityLabel(sensor.type)} ${sensor.id}`}
          xstyle={styles.xs}
          onChange={(event) => {
            const label = event.target.value.trim();
            replaceSensor(editorDocument, roleId, sensor, { label: label === "" ? undefined : label.slice(0, 200) });
          }}
          placeholder={modalityLabel(sensor.type)}
          value={sensor.label ?? ""}
        />
      </label>

      <ChipGroup
        active={mountPreset?.id}
        label="Position"
        note={mountPreset ? undefined : "Custom"}
        onSelect={(id) => {
          const preset = SENSOR_MOUNT_PRESETS.find((candidate) => candidate.id === id);
          if (!preset) return;
          const resolved = resolveSensorMountPreset(preset, actor);
          // A named position moves the sensor without re-aiming it: the author
          // set the aim separately and moving a camera to the roof must not
          // silently point it forward again.
          replaceSensor(editorDocument, roleId, sensor, {
            mount: { position: resolved.position, rotation: sensor.mount.rotation },
          });
        }}
        options={SENSOR_MOUNT_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
      />

      <ChipGroup
        active={aimPreset?.id}
        label="Aim"
        note={aimPreset ? undefined : `${deg(sensor.mount.rotation.yawRad)}°`}
        onSelect={(id) => {
          const preset = SENSOR_AIM_PRESETS.find((candidate) => candidate.id === id);
          if (!preset) return;
          replaceSensor(editorDocument, roleId, sensor, {
            mount: {
              position: sensor.mount.position,
              rotation: { ...sensor.mount.rotation, yawRad: preset.yawDeg * DEG_TO_RAD },
            },
          });
        }}
        options={SENSOR_AIM_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
      />

      <ChipGroup
        active={fovPresetsFor(sensor.type).find(
          (preset) => Math.abs(preset.horizontalFovDeg - aperture.horizontalFovDeg) < 0.5,
        )?.label}
        label="Field of view"
        note={`${Math.round(aperture.horizontalFovDeg)}° wide · ${Math.round(aperture.verticalFovDeg)}° tall`}
        onSelect={(id) => {
          const preset = fovPresetsFor(sensor.type).find((candidate) => candidate.label === id);
          if (!preset) return;
          replaceAperture(editorDocument, roleId, sensor, { horizontalFovDeg: preset.horizontalFovDeg });
        }}
        options={fovPresetsFor(sensor.type).map((preset) => ({ id: preset.label, label: preset.label }))}
      />

      <div>
        <span {...stylex.props(styles.capsMonoMicro2)}>Range</span>
        <div {...stylex.props(styles.gridCols2Gap2)}>
          <NumberBox
            label={`Near range in metres for ${name}`}
            min={0}
            onChange={(nearM) => replaceAperture(editorDocument, roleId, sensor, { nearM })}
            step={0.1}
            suffix="m near"
            value={aperture.nearM}
          />
          <NumberBox
            label={`Far range in metres for ${name}`}
            min={0}
            onChange={(farM) => replaceAperture(editorDocument, roleId, sensor, { farM })}
            step={5}
            suffix="m far"
            value={aperture.farM}
          />
        </div>
      </div>

      <div {...stylex.props(styles.ruleT)}>
        <button
          aria-expanded={showNumbers}
          className={stylex.props(styles.capsMonoMicro3, motionStyles.editorMotion).className}
          onClick={() => setShowNumbers((open) => !open)}
          type="button"
        >
          {showNumbers ? "Hide exact mount" : "Exact mount"}
        </button>
        {showNumbers ? (
          <div {...stylex.props(styles.mt2StackMd)}>
            <p {...stylex.props(styles.microMuted)}>
              Actor-local metres: +X forward, +Y up, +Z left.
            </p>
            <div {...stylex.props(styles.gridCols3Gap2)}>
              {(["x", "y", "z"] as const).map((axis) => (
                <NumberBox
                  key={axis}
                  label={`${axis.toUpperCase()} offset in metres for ${name}`}
                  onChange={(value) =>
                    replaceSensor(editorDocument, roleId, sensor, {
                      mount: {
                        position: { ...sensor.mount.position, [axis]: value },
                        rotation: sensor.mount.rotation,
                      },
                    })
                  }
                  step={0.05}
                  suffix={`${axis} m`}
                  value={sensor.mount.position[axis]}
                />
              ))}
            </div>
            <div {...stylex.props(styles.gridCols3Gap2)}>
              {(["yawRad", "pitchRad", "rollRad"] as const).map((axis) => {
                const limit = axis === "pitchRad" ? 90 : 180;
                const short = axis.slice(0, -3);
                return (
                  <NumberBox
                    key={axis}
                    label={`${short} in degrees for ${name}`}
                    onChange={(value) =>
                      replaceSensor(editorDocument, roleId, sensor, {
                        mount: {
                          position: sensor.mount.position,
                          rotation: {
                            ...sensor.mount.rotation,
                            [axis]: clamp(value, -limit, limit) * DEG_TO_RAD,
                          },
                        },
                      })
                    }
                    step={1}
                    suffix={`${short} °`}
                    value={deg(sensor.mount.rotation[axis])}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChipGroup({
  active,
  label,
  note,
  onSelect,
  options,
}: {
  active: string | undefined;
  label: string;
  note?: string;
  onSelect: (id: string) => void;
  options: readonly { id: string; label: string }[];
}) {
  return (
    <div>
      <span {...stylex.props(styles.flexBetweenBaseline)}>
        <span {...stylex.props(styles.capsMonoMicro2)}>{label}</span>
        {note ? <span {...stylex.props(styles.monoMicroMuted)}>{note}</span> : null}
      </span>
      <div aria-label={label} {...stylex.props(styles.flexWrapGap1)} role="group">
        {options.map((option) => {
          const selected = option.id === active;
          return (
            <button
              aria-pressed={selected}
              className={stylex.props(selected ? styles.microAccentBordered : styles.microMutedBordered, motionStyles.editorMotion).className}
              key={option.id}
              onClick={() => onSelect(option.id)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NumberBox({
  label,
  min,
  onChange,
  step,
  suffix,
  value,
}: {
  label: string;
  min?: number;
  onChange: (value: number) => void;
  step: number;
  suffix: string;
  value: number;
}) {
  return (
    <label {...stylex.props(styles.block)}>
      <span {...stylex.props(styles.srOnly)}>{label}</span>
      <span {...stylex.props(styles.relBlock)}>
        <Input
          aria-label={label}
          xstyle={styles.xs2}
          min={min}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          step={step}
          type="number"
          value={Math.round(value * 1000) / 1000}
        />
        <span {...stylex.props(styles.absMonoMicro)}>
          {suffix}
        </span>
      </span>
    </label>
  );
}

/**
 * Aperture edits are clamped to the modality's own schema bounds, because the
 * document parses on save and a rejected sensor would lose the whole edit.
 */
function replaceAperture(
  editorDocument: EditorDocument,
  roleId: string,
  sensor: ActorSensor,
  patch: Partial<ActiveSensorField>,
) {
  const current = sensorAperture(sensor);
  const camera = sensor.type === "dash_camera";
  const horizontalFovDeg = clamp(
    patch.horizontalFovDeg ?? current.horizontalFovDeg,
    camera ? 10 : 5,
    camera ? 170 : 360,
  );
  const verticalFovDeg = clamp(
    patch.verticalFovDeg ?? current.verticalFovDeg,
    camera ? 5 : 2,
    camera ? 170 : 180,
  );
  const nearM = clamp(patch.nearM ?? current.nearM, 0.001, Math.min(10, current.farM - 0.001));
  const farM = clamp(Math.max(patch.farM ?? current.farM, nearM + 0.001), nearM + 0.001, 100_000);
  const aperture = { horizontalFovDeg, verticalFovDeg, nearM, farM };

  if (sensor.type === "dash_camera") {
    replaceSensor(editorDocument, roleId, sensor, { camera: { ...sensor.camera, ...aperture } });
    return;
  }
  replaceSensor(editorDocument, roleId, sensor, { field: { ...sensor.field, ...aperture } });
}

function replaceSensor(
  editorDocument: EditorDocument,
  roleId: string,
  sensor: ActorSensor,
  patch: {
    enabled?: boolean;
    label?: string | undefined;
    mount?: SensorMount;
    camera?: DashCameraSensor["camera"];
    field?: ActiveSensorField;
  },
) {
  editorDocument.updateActorSensor(roleId, sensor.id, {
    ...sensor,
    ...patch,
    id: sensor.id,
  } as ActorSensor);
}
