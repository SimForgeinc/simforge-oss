"use client";

import { CloudSun } from "lucide-react";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { AuthoredRenderSensor } from "./render-spec-v3";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./recording-panel-fields.stylex";

/**
 * Reusable leaf controls and read-outs for render configuration surfaces.
 *
 * These stay presentation-only: renderer execution and artifact transfer belong to the registered
 * SimForge worker, never to a component using these fields.
 */

export type CameraOption = AuthoredRenderSensor & {
  sensor: Extract<AuthoredRenderSensor["sensor"], { type: "dash_camera" }>;
};

export function cameraKey(camera: AuthoredRenderSensor) {
  return `${camera.actorId}:${camera.sensor.id}`;
}

export function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function EnvironmentSummary({ content }: { content: ScenarioTemplateV2 | null }) {
  const environment = content?.environment;
  if (!environment) return null;
  return (
    <section {...stylex.props(styles.ruleT)} aria-labelledby="recording-environment-heading">
      <div {...stylex.props(styles.flexCenterGap2)}>
        <CloudSun aria-hidden="true" className={stylex.props(styles.muted).className} />
        <h3 {...stylex.props(styles.capsMicroMuted)} id="recording-environment-heading">
          Environment included
        </h3>
      </div>
      <dl {...stylex.props(styles.gridXsCols2)}>
        <SummaryValue label="Weather" value={humanize(environment.weather)} />
        <SummaryValue label="Time of day" value={humanize(environment.timeOfDay)} />
        <SummaryValue
          label="Friction"
          value={environment.frictionScale == null
            ? "Preset default"
            : typeof environment.frictionScale === "number"
              ? `${environment.frictionScale}×`
              : "Parameterized"}
        />
        <SummaryValue label="Surface patches" value={String(environment.surfacePatches.length)} />
      </dl>
      <p {...stylex.props(styles.microMuted)}>
        Weather, lighting, friction and surface configuration are frozen into the recording manifest.
      </p>
    </section>
  );
}

function SummaryValue({ label, value }: { label: string; value: string }) {
  return <div><dt {...stylex.props(styles.muted2)}>{label}</dt><dd {...stylex.props(styles.medium)}>{value}</dd></div>;
}

export function NumberInput({ label, value, onChange, ...input }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label {...stylex.props(styles.xs)}>
      <span {...stylex.props(styles.medium)}>{label}</span>
      <input {...input} {...stylex.props(styles.smBorderedWide, styles.stackedXs)} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} type="number" value={value} />
    </label>
  );
}

export function SelectInput({ label, value, onChange, options, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label {...stylex.props(styles.xs)}>
      <span {...stylex.props(styles.medium)}>{label}</span>
      <select {...stylex.props(styles.xsBorderedWide, styles.stackedXs)} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} value={value}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
