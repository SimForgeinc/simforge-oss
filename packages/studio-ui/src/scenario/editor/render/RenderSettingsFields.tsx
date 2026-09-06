"use client";

import {
  TIME_OF_DAY_PRESETS,
  WEATHER_PRESETS,
  type Environment,
  type TimeOfDay,
  type Weather,
} from "@simforge-oss/scenario";

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
    <div className="grid gap-5">
      <section aria-labelledby="render-format-heading">
        <div className="mb-2">
          <h4 className="text-micro font-semibold uppercase tracking-meta text-foreground/80" id="render-format-heading">
            Capture
          </h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose how much of the frozen scenario the worker renders.
          </p>
        </div>
        <label className="flex max-w-xs flex-col gap-1 text-xs">
          <span className="text-micro uppercase tracking-meta text-muted-foreground">Duration</span>
          <select
            className="render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className="mb-2">
          <h4 className="text-micro font-semibold uppercase tracking-meta text-foreground/80" id="render-environment-heading">
            Environment
          </h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            SimForge resolves these canonical authored presets into renderer lighting and atmosphere.
          </p>
        </div>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-micro uppercase tracking-meta text-muted-foreground">Weather</span>
            <select
              className="render-glass border px-2 py-1.5 capitalize text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="render-weather"
              disabled={disabled}
              onChange={(event) => onEnvironmentChange({
                ...environment,
                weather: event.target.value as Weather,
              })}
              value={environment.weather}
            >
              {WEATHER_PRESETS.map((weather) => (
                <option className="capitalize" key={weather} value={weather}>
                  {weather.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-micro uppercase tracking-meta text-muted-foreground">Time of day</span>
            <select
              className="render-glass border px-2 py-1.5 capitalize text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                <option className="capitalize" key={timeOfDay} value={timeOfDay}>
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
