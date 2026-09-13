"use client";

import { useState } from "react";
import { Radio, SlidersHorizontal } from "lucide-react";
import { defaultDashCamera } from "@simforge-oss/scenario";
import { Switch } from "../../../components/ui/switch";
import type { ActorRecord, EditorDocument } from "@simforge-oss/editor";
import { SensorSetupModal } from "./SensorSetupModal";
import {
  appliedRigPreset,
  modalityLabel,
  sensorCounts,
  sensorCountSummary,
  sensorName,
} from "./sensor-presentation";
import { EDITOR_SENSOR_RIGS } from "./sensor-rig-presets";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ActorSensorsSection.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * Sensors, as much of them as a 192px rail can honestly show.
 *
 * The rail answers "what is fitted and is it live" — a summary, the applied rig
 * name and one switch per sensor. Placing and aiming happens in
 * `SensorSetupModal`, which has room for the vehicle plan; cramming that here
 * is what made the previous version unusable.
 *
 * Sensors are read from the document's role rather than from `ActorRecord`:
 * the mount is authored data that round-trips through export, while the
 * record's copy is a render-time projection.
 */
export function ActorSensorsSection({
  actor,
  document,
}: {
  actor: ActorRecord;
  document: EditorDocument;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const role = document.data.roles.find((candidate) => candidate.id === actor.id);
  if (!role) return null;

  const sensors = role.actor.sensors;
  const counts = sensorCounts(sensors);
  const rig = appliedRigPreset(sensors, role.actor, EDITOR_SENSOR_RIGS);

  return (
    <section aria-labelledby="scenario-sensors-heading" {...stylex.props(styles.stackSm)}>
      <div {...stylex.props(styles.flexBetweenBaseline)}>
        <span
          {...stylex.props(styles.caps)}
          id="scenario-sensors-heading"
        >
          Sensors
        </span>
        {counts.total > 0 ? (
          <span {...stylex.props(styles.mono)}>{counts.total}</span>
        ) : null}
      </div>

      {counts.total === 0 ? (
        <p {...stylex.props(styles.textLeading3TextWhite35)}>
          Add a camera or a full perception rig to record the scenario.
        </p>
      ) : (
        <p {...stylex.props(styles.textLeading3TextWhite45)}>
          {rig ? rig.name : sensorCountSummary(counts)}
          <span {...stylex.props(styles.block)}>Records the scenario</span>
        </p>
      )}

      {sensors.map((sensor) => {
        const name = sensorName(sensor);
        return (
          <div {...stylex.props(styles.flexCenterGap15)} key={sensor.id} data-sensor-id={sensor.id}>
            <span {...stylex.props(styles.fillTruncateNarrowable)} title={name}>
              {name}
              <span {...stylex.props(styles.ml1TextTextWhite30)}>{modalityLabel(sensor.type)}</span>
            </span>
            <Switch
              aria-label={`${name} (${sensor.id}) enabled`}
              checked={sensor.enabled}
              xstyle={styles.scale75}
              onCheckedChange={(enabled) =>
                document.updateActorSensor(role.id, sensor.id, { ...sensor, enabled })
              }
            />
          </div>
        );
      })}

      <div {...stylex.props(styles.flexGap15)}>
        <button
          className={stylex.props(styles.flexCenterMid, motionStyles.editorMotion).className}
          data-testid="open-sensor-setup"
          onClick={() => setSetupOpen(true)}
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" className={stylex.props(styles.size3).className} />
          {counts.total === 0 ? "Add sensors" : "Configure"}
        </button>
        {counts.total === 0 ? (
          <button
            aria-label="Add dash camera"
            className={stylex.props(styles.flexCenterMid2, motionStyles.editorMotion).className}
            onClick={() => document.addActorSensor(role.id, defaultDashCamera(role.actor))}
            type="button"
          >
            <Radio aria-hidden="true" className={stylex.props(styles.size3).className} />
            Camera
          </button>
        ) : null}
      </div>

      {setupOpen ? (
        <SensorSetupModal
          actor={role.actor}
          document={document}
          label={role.label ?? actor.label ?? role.id}
          onClose={() => setSetupOpen(false)}
          roleId={role.id}
        />
      ) : null}
    </section>
  );
}
