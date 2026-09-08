import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import {
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/**
 * Stage an evaluation input on this machine so a LOCAL run can reference it.
 *
 * The local open-loop executor takes a filesystem path per params item, not an
 * artifact id — it reads the clip directly and never uploads it. A browser
 * `File` has no path, so the renderer cannot supply one, and without this route
 * the desktop's "run on this machine" choice is a control the UI can display
 * but the user cannot actually use.
 *
 * Content-addressed by digest, under the same root the model-run worker writes
 * its output to (`SIMFORGE_RUNS_ROOT`, else `~/simforge-assets`): re-staging the
 * same clip is free, and a local run's inputs sit beside its results rather
 * than in a temp directory that a reboot removes.
 *
 * Nothing here leaves the machine. This is deliberately not the cloud upload
 * path: no storage grant, no artifact id, no network.
 */

const MAX_LOCAL_INPUT_BYTES = 8 * 1024 * 1024 * 1024;

function localInputsRoot(): string {
  const runsRoot = process.env.SIMFORGE_RUNS_ROOT?.trim();
  if (runsRoot) return join(runsRoot, "..", "eval-inputs");
  return join(homedir(), "simforge-assets", "eval-inputs");
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "invalid_local_input", detail: "expected a multipart `file` part" },
      { status: 400 },
    );
  }
  if (file.size > MAX_LOCAL_INPUT_BYTES) {
    return NextResponse.json(
      { error: "local_input_too_large", detail: { sizeBytes: file.size, limit: MAX_LOCAL_INPUT_BYTES } },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // The stored name keeps the user's filename so a run's inputs are legible on
  // disk, but the directory is the digest, so two different clips with the same
  // name cannot collide.
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "input";
  const directory = join(localInputsRoot(), sha256);
  const path = join(directory, safeName);

  await mkdir(directory, { recursive: true });
  await writeFile(path, bytes);

  return NextResponse.json(
    { path, sha256, bytes: bytes.byteLength, mediaType: file.type || "application/octet-stream" },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
