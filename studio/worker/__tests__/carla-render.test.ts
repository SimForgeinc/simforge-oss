import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { offeredEngines } from "../index.js";

it("offers CARLA exactly when executable and permitted by worker capabilities", () => {
  const root = mkdtempSync(join(tmpdir(), "carla-offer-"));
  const binary = join(root, "adapter");
  const previous = { ...process.env };
  try {
    process.env.SIMFORGE_CARLA_BINARY = binary;
    process.env.CARLA_HOST = "127.0.0.1";
    process.env.CARLA_PORT = "2000";
    for (const present of [false, true]) {
      if (present) writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      for (const configured of [undefined, "carla-render", "browser-render", "native-render,carla-render"]) {
        if (configured === undefined) delete process.env.SIMFORGE_WORKER_CAPABILITIES;
        else process.env.SIMFORGE_WORKER_CAPABILITIES = configured;
        const result = offeredEngines();
        assert.equal(result.engines.includes("carla"), present && (configured === undefined || configured.includes("carla-render")));
        assert.equal(result.reasons.carla.length === 0, present);
      }
    }
    process.env.SIMFORGE_NATIVE_RENDER_BINARY = binary;
    process.env.SIMFORGE_FFMPEG_BINARY = binary;
    process.env.SIMFORGE_FFPROBE_BINARY = binary;
    process.env.CHROMIUM_EXECUTABLE_PATH = binary;
    process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL = "https://assets.example.test";
    for (const engine of ["browser", "native", "carla"]) {
      process.env.SIMFORGE_WORKER_CAPABILITIES = `${engine}-render`;
      assert.deepEqual(offeredEngines().engines, [engine]);
    }
    delete process.env.SIMFORGE_WORKER_CAPABILITIES;
    assert.deepEqual(offeredEngines().engines, ["browser", "native", "carla"]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a CARLA lease whose inputs lack download URLs instead of skipping them", async () => {
  const { leasedInputsWithDownloads } = await import("../carla-render.js");
  const sha256 = "a".repeat(64);
  const download = { url: "https://example.test/input", headers: {} };
  assert.deepEqual(
    leasedInputsWithDownloads({ jobId: "job-1", inputs: [{ inputId: "map", sha256, sizeBytes: 1, download }] }),
    [{ inputId: "map", sha256, sizeBytes: 1, download }],
  );
  assert.throws(
    () => leasedInputsWithDownloads({ jobId: "job-1", inputs: [{ inputId: "map", sha256, sizeBytes: 1 }] }),
    /job-1: input map has no download URL/,
  );
});
