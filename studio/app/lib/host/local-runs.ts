"use client";

/**
 * Starting an evaluation run on this machine.
 *
 * The desktop offers two execution targets and both have to be real. The cloud
 * one goes through the compute control plane; this is the other half — the
 * local model-run queue that `worker/model-run.ts` leases from, which runs the
 * same open-loop core and writes the same
 * `simforge.eval-result-manifest/v1` document the cloud worker writes. One
 * result schema, two executors.
 *
 * Three things differ from the cloud path and are handled here rather than in
 * the shared UI:
 *  - inputs are staged on disk and referenced by PATH (`ref`), not uploaded and
 *    referenced by artifact id (`role`);
 *  - the model is named by the local registry's version and endpoint ids, which
 *    have to be resolved from the family and quantization the user chose;
 *  - open-loop needs an endpoint whose engine speaks the HTTP-JSON facade, so an
 *    msgpack-only endpoint is refused here with that reason instead of failing
 *    an attempt.
 */

import type { ModelFamilyId, ModelQuant } from "@simforge-oss/studio-ui/evaluation";

export type LocalRunStart = {
  runId: string;
  modelVersionId: string;
  endpointId: string;
};

/** Why a local run could not be started, in words the launcher can render. */
export class LocalRunUnavailable extends Error {
  readonly code:
    | "model_not_installed"
    | "no_local_endpoint"
    | "endpoint_transport_unsupported"
    | "input_staging_failed"
    | "rejected";

  constructor(code: LocalRunUnavailable["code"], message: string) {
    super(message);
    this.name = "LocalRunUnavailable";
    this.code = code;
  }
}

type ModelVersionRow = {
  id: string;
  family: string;
  quant: string;
  checkpointDigest: string;
};

type ModelEndpointRow = {
  id: string;
  modelVersionId: string;
  descriptor?: { invoke?: { kind?: string } } | null;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new LocalRunUnavailable("rejected", `${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Stage one input on disk and return its absolute path.
 *
 * Sequential by design: these are multi-gigabyte clips and the local disk is
 * the bottleneck, so parallel writes would only compete.
 */
async function stageLocalInput(file: File): Promise<string> {
  const body = new FormData();
  body.set("file", file);
  const response = await fetch("/api/simforge/local-eval-inputs", { method: "POST", body });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new LocalRunUnavailable(
      "input_staging_failed",
      `${file.name} could not be staged for a local run (${response.status}). ${detail}`.trim(),
    );
  }
  const staged = (await response.json()) as { path: string };
  return staged.path;
}

/**
 * Resolve the installed model and its local endpoint, then queue the run.
 *
 * `params` arrives built for the cloud (each item naming a `role`); the items
 * are rewritten to name the staged `ref` path instead, in the same order, which
 * is what pairs an item with its clip.
 */
export async function startLocalRun(input: {
  family: ModelFamilyId;
  quant: ModelQuant;
  files: File[];
  params: Record<string, unknown>;
  seed: number;
}): Promise<LocalRunStart> {
  const { versions } = await getJson<{ versions: ModelVersionRow[] }>("/api/models/versions");
  const version = versions.find(
    (candidate) => candidate.family === input.family && candidate.quant === input.quant,
  );
  if (!version) {
    throw new LocalRunUnavailable(
      "model_not_installed",
      `${input.family} (${input.quant}) is not registered on this machine. Install it in Models first — downloading it is what registers a version to run against.`,
    );
  }

  const { endpoints } = await getJson<{ endpoints: ModelEndpointRow[] }>(
    `/api/models/endpoints?modelVersionId=${encodeURIComponent(version.id)}`,
  );
  if (endpoints.length === 0) {
    throw new LocalRunUnavailable(
      "no_local_endpoint",
      `No local endpoint is registered for ${input.family} (${input.quant}). The model engine has to be running on this machine for a local run.`,
    );
  }
  // Open loop drives the engine's HTTP-JSON facade; an msgpack-only endpoint
  // serves closed-loop `act` and cannot answer it.
  const endpoint =
    endpoints.find((candidate) => candidate.descriptor?.invoke?.kind === "http-json") ?? null;
  if (!endpoint) {
    throw new LocalRunUnavailable(
      "endpoint_transport_unsupported",
      `The local endpoint for ${input.family} does not offer the HTTP-JSON facade that open-loop evaluation needs. Closed-loop episodes use its socket transport instead.`,
    );
  }

  const refs: string[] = [];
  for (const file of input.files) refs.push(await stageLocalInput(file));

  const items = Array.isArray(input.params.items) ? input.params.items : [];
  const localParams = {
    ...input.params,
    items: items.map((item, index) => {
      const { role: _role, ...rest } = (item ?? {}) as Record<string, unknown>;
      return { ...rest, ref: refs[index] ?? refs[0] };
    }),
  };

  const response = await fetch("/api/models/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      modelVersionId: version.id,
      endpointId: endpoint.id,
      kind: "openloop",
      params: localParams,
      seed: input.seed,
    }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; details?: unknown }
      | null;
    throw new LocalRunUnavailable(
      "rejected",
      `The local run was refused (${payload?.error ?? response.status}). ${
        payload?.details ? JSON.stringify(payload.details) : ""
      }`.trim(),
    );
  }
  // 201 returns the run row itself, not a wrapper.
  const created = (await response.json()) as { id?: string };
  const runId = created.id;
  if (!runId) {
    throw new LocalRunUnavailable("rejected", "The local run was created but no run id came back.");
  }
  return { runId, modelVersionId: version.id, endpointId: endpoint.id };
}
