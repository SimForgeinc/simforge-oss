// Shared turbo invocation: one cache directory per layout shared by every
// worktree on the machine, plus the remote cache (Depot, else S3) when available.
import { join } from "node:path";
import { turboRemoteCache } from "./remote-cache.mjs";
import { jobsPerSlot } from "./slots.mjs";
import { CACHE_ROOT } from "./util.mjs";

export function turboBin(root) {
  return join(root, "node_modules/.bin/turbo");
}

export function turboFlags(layout) {
  return [
    "--continue",
    "--output-logs=errors-only",
    "--summarize",
    `--cache-dir=${join(CACHE_ROOT, "turbo", layout.name)}`,
    `--concurrency=${jobsPerSlot()}`,
    "--env-mode=loose",
    "--ui=stream",
    "--log-order=grouped",
  ];
}

/** argv + env for `turbo run <tasks> --filter=<pkg>...`; call close() when done. */
export async function turboCommand(layout, root, tasks, filters, { remote = true } = {}) {
  const cache = await turboRemoteCache(layout, { enabled: remote });
  return {
    bin: turboBin(root),
    args: ["run", ...tasks, ...filters.map((f) => (f.startsWith("--filter=") ? f : `--filter=${f}`)), ...turboFlags(layout)],
    env: cache.env,
    remoteKind: cache.kind,
    stats: cache.stats,
    close: cache.close,
  };
}
