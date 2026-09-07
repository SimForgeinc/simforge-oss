import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readLocalHostState } from "@simforge-oss/studio-host/node";

/**
 * Install the real published maps into a running local Studio through its
 * own map install routes — the same path the product takes on first use.
 * Anonymously this is exactly the public Richmond Field Station; with an
 * active SimCloud connection it is every map the account may read.
 *
 *   tsx scripts/bootstrap-public-maps.ts [--profile browser,semantic] [--map <mapVersionId>]...
 *
 * Requires the local host to be running (reads its host.json record for the
 * base URL and per-start control token). Exits non-zero when any requested
 * install ends in error, so an installer or qualification step cannot mistake
 * a partial closure for a ready map.
 */

type Profile = "browser" | "semantic";
type CatalogMap = {
  mapVersionId: string;
  label: string;
  access: "public" | "local" | "cloud";
  locked: boolean;
  installed: { browser: boolean; semantic: boolean };
};
type InstallState = {
  state: "idle" | "materializing" | "ready" | "error";
  progress: { members: number; completedMembers: number; bytes: number; completedBytes: number } | null;
  directory: string | null;
  message: string | null;
};

function parseArgs(argv: readonly string[]) {
  const profiles = new Set<Profile>();
  const maps: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--profile") {
      for (const value of (argv[++index] ?? "").split(",")) {
        if (value === "browser" || value === "semantic") profiles.add(value);
        else throw new Error(`unknown profile ${value}`);
      }
    } else if (argument === "--map") {
      const value = argv[++index];
      if (!value) throw new Error("--map requires a map version id");
      maps.push(value);
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (profiles.size === 0) {
    profiles.add("browser");
    profiles.add("semantic");
  }
  return { profiles: [...profiles], maps };
}

export async function bootstrapPublicMaps(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { profiles, maps: requested } = parseArgs(argv);
  const host = await readLocalHostState();
  if (!host) {
    console.error("local Studio host is not running (no host record); start it first");
    return 2;
  }
  const headers = { authorization: `Bearer ${host.controlToken}`, accept: "application/json" };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(new URL(path, host.baseUrl), {
      ...init,
      headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
    }
    return response.json();
  };

  const catalog = (await request("/api/simforge/maps") as { maps: CatalogMap[] }).maps;
  const targets = catalog.filter((map) =>
    (requested.length === 0 ? map.access !== "local" && !map.locked : requested.includes(map.mapVersionId)));
  const missing = requested.filter((id) => !catalog.some((map) => map.mapVersionId === id));
  if (missing.length > 0) {
    console.error(`not in the catalog available to this installation: ${missing.join(", ")}`);
    return 1;
  }
  if (targets.length === 0) {
    console.log("no installable published maps in the catalog");
    return 0;
  }

  let failures = 0;
  for (const map of targets) {
    for (const profile of profiles) {
      const path = `/api/simforge/maps/${encodeURIComponent(map.mapVersionId)}/install`;
      let state = await request(path, { method: "POST", body: JSON.stringify({ profile }) }) as InstallState;
      let lastLine = "";
      while (state.state === "materializing" || state.state === "idle") {
        await sleep(1_000);
        state = await request(`${path}?profile=${profile}`) as InstallState;
        const progress = state.progress;
        const line = progress
          ? `${map.label} [${profile}] ${progress.completedMembers}/${progress.members} members, `
            + `${(progress.completedBytes / 1_048_576).toFixed(1)}/${(progress.bytes / 1_048_576).toFixed(1)} MiB`
          : `${map.label} [${profile}] preparing`;
        if (line !== lastLine) {
          console.log(line);
          lastLine = line;
        }
      }
      if (state.state === "ready") {
        console.log(`ready ${map.mapVersionId} [${profile}] -> ${state.directory}`);
      } else {
        failures += 1;
        console.error(`failed ${map.mapVersionId} [${profile}]: ${state.message ?? "unknown error"}`);
      }
    }
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await bootstrapPublicMaps());
}
