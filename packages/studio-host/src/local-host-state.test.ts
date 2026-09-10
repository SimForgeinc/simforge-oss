import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  LOCAL_HOST_STATE_FILE,
  readLocalHostPort,
  readLocalHostState,
  removeLocalHostState,
  writeLocalHostState,
} from "./node/local-host-state";

it("retains the renderer origin after removing the per-start control record", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-host-port-"));
  const env = { SIMFORGE_CLOUD_ROOT: root };
  try {
    await writeLocalHostState({
      schema: "simforge.local-host-state/v1",
      pid: process.pid,
      port: 55204,
      baseUrl: "http://127.0.0.1:55204",
      controlToken: "test-only-control-token",
      startedAt: new Date(0).toISOString(),
      withWorker: false,
    }, env);
    await removeLocalHostState(env);

    expect(await readLocalHostState(env)).toBeNull();
    await expect(readFile(join(root, LOCAL_HOST_STATE_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLocalHostPort(env)).toBe(55204);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("ignores a saved endpoint outside the TCP port range", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-host-port-"));
  try {
    await writeFile(join(root, "host-port.json"), "65536\n");
    expect(await readLocalHostPort({ SIMFORGE_CLOUD_ROOT: root })).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
