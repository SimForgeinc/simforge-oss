"use client";

import { Gauge, Plus, Trash2 } from "lucide-react";
import { defaultDashCamera, type ActorSensor } from "@simforge-oss/scenario";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import type { EditorDocument } from "@simforge-oss/editor";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ActorCameras.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

type Role = EditorDocument["data"]["roles"][number];

/**
 * Compact sensor authoring beside the timeline.
 *
 * The inspector owns precise mount geometry; this dock keeps the clip-level
 * overview honest for every modality and provides the high-frequency
 * enable/remove actions without mislabelling LiDAR or radar as cameras.
 */
export function ActorCameras({
  document,
  role,
}: {
  document: EditorDocument;
  role: Role | null;
}) {
  return (
    <div {...stylex.props(styles.tightInkRuleL)}>
      <h2 {...stylex.props(styles.flexCenterCaps)}>
        <Gauge aria-hidden="true" className={stylex.props(styles.mr2Size3).className} />
        Actor sensors
      </h2>
      {role ? (
        <>
          <div {...stylex.props(styles.flexCenterXs)}>
            <span>{sensorSummary(role.actor.sensors)}</span>
            <Button
              size="sm"
              variant="ghost"
              xstyle={styles.accentPushRight}
              onClick={() =>
                document.addActorSensor(
                  role.id,
                  defaultDashCamera(role.actor),
                )
              }
            >
              <Plus aria-hidden="true" />
              Camera
            </Button>
          </div>
          {role.actor.sensors.map((sensor) => {
            const kind = sensorKind(sensor);
            const name = sensor.label ?? kind;
            const controlName = `${name} (${sensor.id})`;
            return (
              <div
                key={sensor.id}
                {...stylex.props(styles.flexCenterMeta)}
              >
                <span {...stylex.props(styles.fillTruncateNarrowable)}>
                  {name}
                  <span {...stylex.props(styles.microMuted)}>
                    {kind}
                  </span>
                </span>
                <Switch
                  aria-label={`${controlName} enabled in timeline`}
                  checked={sensor.enabled}
                  onCheckedChange={(enabled) =>
                    document.updateActorSensor(role.id, sensor.id, {
                      ...sensor,
                      enabled,
                      id: sensor.id,
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove ${controlName} from timeline`}
                  className={stylex.props(styles.muted, motionStyles.editorMotion).className}
                  onClick={() => document.removeActorSensor(role.id, sensor.id)}
                >
                  <Trash2 aria-hidden="true" className={stylex.props(styles.size3).className} />
                </button>
              </div>
            );
          })}
        </>
      ) : (
        <p {...stylex.props(styles.xsMuted)}>
          Select an actor to attach sensors.
        </p>
      )}
    </div>
  );
}

function sensorSummary(sensors: readonly ActorSensor[]) {
  const counts = sensors.reduce(
    (value, sensor) => {
      value[sensor.type] += 1;
      return value;
    },
    { dash_camera: 0, lidar: 0, radar: 0 },
  );
  return `${counts.dash_camera} camera · ${counts.lidar} LiDAR · ${counts.radar} radar`;
}

function sensorKind(sensor: ActorSensor) {
  if (sensor.type === "dash_camera") return "Camera";
  if (sensor.type === "lidar") return "LiDAR";
  return "Radar";
}
