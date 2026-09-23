/**
 * Public runtime configuration: the browser-visible `NEXT_PUBLIC_*` settings,
 * read at REQUEST time instead of being inlined at build time.
 *
 * Next.js inlines every `process.env.NEXT_PUBLIC_*` it sees when it builds, so
 * a bundle is tied to the environment it was built for. Reading them here
 * instead lets one build serve every environment it is deployed to:
 *
 * - In the browser, values come from `window.__SIMFORGE_PUBLIC_CONFIG__`, set by
 *   `/runtime-config.js` (app/runtime-config.js/route.ts), which the root layout
 *   loads `beforeInteractive`, i.e. before any application code runs.
 * - On the server, values come from `process.env` through a computed key, which
 *   no bundler can inline.
 *
 * Never write `process.env.NEXT_PUBLIC_X` anywhere else; `scripts/check-public-env.mjs`
 * fails the build on it. Read values when they are used, not at module load.
 */

declare global {
  interface Window {
    __SIMFORGE_PUBLIC_CONFIG__?: Readonly<Record<string, string>>;
  }
}

export const PUBLIC_ENV_PREFIX = "NEXT_PUBLIC_";

export type PublicEnvName = `NEXT_PUBLIC_${string}`;

/** A public setting of the environment this deployment runs in, or undefined. */
export function publicEnv(name: PublicEnvName): string | undefined {
  if (typeof window !== "undefined") {
    const value = window.__SIMFORGE_PUBLIC_CONFIG__?.[name];
    return value === "" ? undefined : value;
  }
  const env: Record<string, string | undefined> = process.env;
  const value = env[name];
  return value === "" ? undefined : value;
}

/** Every non-empty `NEXT_PUBLIC_*` value of the running server's environment. */
export function publicRuntimeConfig(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const config: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (name.startsWith(PUBLIC_ENV_PREFIX) && typeof value === "string" && value !== "") config[name] = value;
  }
  return config;
}

/** The classic script that installs the config; safe to embed or serve as JavaScript. */
export function publicRuntimeConfigScript(config: Record<string, string>): string {
  const json = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.__SIMFORGE_PUBLIC_CONFIG__=Object.freeze(${json});\n`;
}
