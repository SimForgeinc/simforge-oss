/**
 * Every environment knob the E2E harness reads, in one place. Names are part
 * of the CI contract: the workflow sets them, the specs never read
 * `process.env` directly.
 */
export const E2E_ENV = {
  /** `browser` (default) or `electron`; the launch mode the shared fixtures use. */
  mode: "SIMFORGE_E2E_MODE",
  /** Parent directory for per-run isolated data roots; defaults to the OS temp dir. */
  dataRoot: "SIMFORGE_E2E_DATA_ROOT",
  /** Keep the isolated roots after a run instead of removing them. */
  keepDataRoot: "SIMFORGE_E2E_KEEP_DATA_ROOT",
  /** `dev` (default, `next dev`) or `start` (serves a previous `next build`). */
  hostMode: "SIMFORGE_E2E_HOST_MODE",
  /** A real installed map corpus root (the directory holding `dev-assets/`). */
  mapsFixtureRoot: "SIMFORGE_E2E_MAPS_FIXTURE_ROOT",
  /** Native/GPU runner binary for interop coverage. */
  nativeRunnerBin: "SIMFORGE_E2E_NATIVE_RUNNER_BIN",
  /** Staging cloud model endpoint. */
  modelBaseUrl: "SIMFORGE_E2E_MODEL_BASE_URL",
  modelApiKey: "SIMFORGE_E2E_MODEL_API_KEY",
  /** `1` when the machine really has a usable GPU for hifi work. */
  gpu: "SIMFORGE_E2E_GPU",
  /** Run the browser headed (debugging); headless otherwise. */
  headed: "SIMFORGE_E2E_HEADED",
  /** A packaged desktop binary to drive instead of the workspace Electron. */
  electronBinary: "SIMFORGE_E2E_ELECTRON_BINARY",
} as const;

export type E2eMode = "browser" | "electron";
export type HostMode = "dev" | "start";

/** A present, non-blank value, or `undefined`. */
export function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function currentMode(env: NodeJS.ProcessEnv = process.env): E2eMode {
  const value = envValue(E2E_ENV.mode, env);
  if (value === undefined || value === "browser") return "browser";
  if (value === "electron") return "electron";
  throw new Error(`${E2E_ENV.mode} must be "browser" or "electron", received ${JSON.stringify(value)}`);
}

export function currentHostMode(env: NodeJS.ProcessEnv = process.env): HostMode {
  const value = envValue(E2E_ENV.hostMode, env);
  if (value === undefined || value === "dev") return "dev";
  if (value === "start") return "start";
  throw new Error(`${E2E_ENV.hostMode} must be "dev" or "start", received ${JSON.stringify(value)}`);
}
