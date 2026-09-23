// Shared remote cache for turbo task outputs and sccache, so one agent's build
// or test result is reused by every other agent on the machine and by CI.
//
// Order: Depot Cache (what CI already uses) -> S3 proxy fallback -> local only.
// Credentials are passed to child processes through the environment and are
// never printed. Depot token lookup: $DEPOT_TOKEN, else the `depot login`
// config (~/.config/depot/depot.yaml). Org: $DEPOT_ORG_ID, else the same file.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startTurboS3Cache } from "./turbo-s3-cache.mjs";

const DEPOT_CACHE = "https://cache.depot.dev";

export function depotCredentials(env = process.env) {
  let token = env.DEPOT_TOKEN?.trim() || "";
  let org = env.DEPOT_ORG_ID?.trim() || "";
  if (!token || !org) {
    try {
      const yaml = readFileSync(join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "depot", "depot.yaml"), "utf8");
      token ||= yaml.match(/^api_token:\s*"?([^"\s]+)"?/m)?.[1] ?? "";
      org ||= yaml.match(/^org_id:\s*"?([^"\s]+)"?/m)?.[1] ?? "";
    } catch {}
  }
  return token && org ? { token, org } : null;
}

/** Env for sccache: local disk first, then the shared remote (multi-level, write errors ignored). */
export function sccacheRemoteEnv(layout, env = process.env) {
  const mode = env.DEVFLOW_REMOTE_CACHE ?? "on";
  if (mode === "0" || mode === "off") return { kind: "local", env: {} };
  const depot = depotCredentials(env);
  if (depot) {
    return {
      kind: "depot",
      env: {
        SCCACHE_MULTILEVEL_CHAIN: "disk,webdav",
        SCCACHE_MULTILEVEL_WRITE_ERROR_POLICY: "ignore",
        SCCACHE_WEBDAV_ENDPOINT: DEPOT_CACHE,
        SCCACHE_WEBDAV_USERNAME: depot.org,
        SCCACHE_WEBDAV_PASSWORD: depot.token,
        SCCACHE_WEBDAV_KEY_PREFIX: `sccache/${layout.name}`,
        ...(mode === "ro" ? { SCCACHE_WEBDAV_RW_MODE: "READ_ONLY" } : {}),
      },
    };
  }
  if (layout.remoteCache?.bucket && env.DEVFLOW_SCCACHE_S3 === "1") {
    return {
      kind: "s3",
      env: {
        SCCACHE_MULTILEVEL_CHAIN: "disk,s3",
        SCCACHE_MULTILEVEL_WRITE_ERROR_POLICY: "ignore",
        SCCACHE_BUCKET: layout.remoteCache.bucket,
        SCCACHE_REGION: layout.remoteCache.region,
        SCCACHE_S3_KEY_PREFIX: `sccache/${layout.name}/`,
      },
    };
  }
  return { kind: "local", env: {} };
}

/**
 * Remote cache for turbo. Resolves { kind, env, stats?, close() }.
 * `kind` is "depot", "s3" or "local".
 */
export async function turboRemoteCache(layout, { enabled = true, env = process.env } = {}) {
  const mode = env.DEVFLOW_REMOTE_CACHE ?? "on";
  const none = { kind: "local", env: {}, close: async () => {} };
  if (!enabled || mode === "0" || mode === "off") return none;
  const depot = depotCredentials(env);
  if (depot) {
    return {
      kind: "depot",
      env: {
        TURBO_API: DEPOT_CACHE,
        TURBO_TOKEN: depot.token,
        TURBO_TEAM: depot.org,
        ...(mode === "ro" ? { TURBO_CACHE: "local:rw,remote:r" } : {}),
      },
      close: async () => {},
    };
  }
  if (layout.remoteCache?.bucket) {
    const proxy = await startTurboS3Cache({ ...layout.remoteCache, readOnly: mode === "ro" });
    if (proxy) {
      return {
        kind: "s3",
        env: { TURBO_API: proxy.url, TURBO_TOKEN: proxy.token, TURBO_TEAM: proxy.team },
        stats: proxy.stats,
        close: proxy.close,
      };
    }
  }
  return none;
}
