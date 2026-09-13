"use client";

import {
  TIME_OF_DAY_PRESETS,
  WEATHER_PRESETS,
  type Environment,
  type TimeOfDay,
  type Weather,
} from "@simforge-oss/scenario";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderSettingsFields.stylex";

const DURATION_PRESETS_SECONDS = [3, 5, 10, 15, 30, 60] as const;


export function RenderSettingsFields({
  disabled,
  durationSeconds,
  environment,
  maxDurationSeconds,
  onDurationChange,
  onEnvironmentChange,
}: {
  disabled: boolean;
  durationSeconds: number;
  environment: Environment;
  maxDurationSeconds: number;
  onDurationChange: (seconds: number) => void;
  onEnvironmentChange: (environment: Environment) => void;
}) {
  const durationOptions = [...new Set([
    ...DURATION_PRESETS_SECONDS.filter((seconds) => seconds <= maxDurationSeconds),
    maxDurationSeconds,
  ])].sort((left, right) => left - right);

  return (
    <div {...stylex.props(styles.gridGap5)}>
      <section aria-labelledby="render-format-heading">
        <div {...stylex.props(styles.mb2)}>
          <h4 {...stylex.props(styles.capsMicroSemibold)} id="render-format-heading">
            Capture
          </h4>
          <p {...stylex.props(styles.xsMuted)}>
            Choose how much of the frozen scenario the worker renders.
          </p>
        </div>
        <label {...stylex.props(styles.flexColXs)}>
          <span {...stylex.props(styles.capsMicroMuted)}>Duration</span>
          <select
            {...stylex.props(styles.inkBordered)}
            data-testid="render-duration"
            disabled={disabled}
            onChange={(event) => onDurationChange(Number(event.target.value))}
            value={String(durationSeconds)}
          >
            {durationOptions.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds}s{seconds === maxDurationSeconds ? " (full scenario)" : ""}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section aria-labelledby="render-environment-heading">
        <div {...stylex.props(styles.mb2)}>
          <h4 {...stylex.props(styles.capsMicroSemibold)} id="render-environment-heading">
            Environment
          </h4>
          <p {...stylex.props(styles.xsMuted)}>
            SimForge resolves these canonical authored presets into renderer lighting and atmosphere.
          </p>
        </div>
        <div {...stylex.props(styles.gridXsGap2)}>
          <label {...stylex.props(styles.flexColGap1)}>
            <span {...stylex.props(styles.capsMicroMuted)}>Weather</span>
            <select
              {...stylex.props(styles.capsInkBordered)}
              data-testid="render-weather"
              disabled={disabled}
              onChange={(event) => onEnvironmentChange({
                ...environment,
                weather: event.target.value as Weather,
              })}
              value={environment.weather}
            >
              {WEATHER_PRESETS.map((weather) => (
                <option {...stylex.props(styles.caps)} key={weather} value={weather}>
                  {weather.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label {...stylex.props(styles.flexColGap1)}>
            <span {...stylex.props(styles.capsMicroMuted)}>Time of day</span>
            <select
              {...stylex.props(styles.capsInkBordered)}
              data-testid="render-time-of-day"
              disabled={disabled}
              onChange={(event) => {
                const nextEnvironment = {
                  ...environment,
                  timeOfDay: event.target.value as TimeOfDay,
                };
                delete nextEnvironment.sunAzimuthDeg;
                delete nextEnvironment.sunElevationDeg;
                onEnvironmentChange(nextEnvironment);
              }}
              value={environment.timeOfDay}
            >
              {TIME_OF_DAY_PRESETS.map((timeOfDay) => (
                <option {...stylex.props(styles.caps)} key={timeOfDay} value={timeOfDay}>
                  {timeOfDay.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
