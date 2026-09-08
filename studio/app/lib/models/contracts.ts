import { z } from "zod";

/**
 * SimForge model registry contracts (`simforge.*` tables, NOT the frozen
 * `uniscenario.*` wire surface).
 *
 * The endpoint descriptor is the single serialized description of "how to
 * reach this model". A run snapshots it into `resolved_descriptor_json` at
 * FIRST lease; retries reuse the snapshot byte-for-byte, so editing an
 * endpoint never changes a run that already started.
 */

export const MODEL_RUN_KINDS = ["openloop", "policy_episode", "artifact"] as const;
export type ModelRunKind = (typeof MODEL_RUN_KINDS)[number];

export const MODEL_QUANTS = ["none", "fp16", "bf16", "int8", "nf4", "gptq", "awq"] as const;

const EndpointHealthSchema = z.discriminatedUnion("kind", [
  /** Poll `GET http://127.0.0.1:<port><path>` until it returns 200. */
  z.object({
    kind: z.literal("http"),
    path: z.string().regex(/^\//).default("/healthz"),
    timeoutMs: z.number().int().positive().max(1_800_000).default(30_000),
  }),
  /**
   * Wait for a stdout line matching `pattern` (e.g. the Alpamayo server prints
   * `READY /tmp/simforge-alpamayo.sock` once its checkpoint is loaded).
   */
  z.object({
    kind: z.literal("stdout"),
    pattern: z.string().min(1),
    timeoutMs: z.number().int().positive().max(1_800_000).default(600_000),
  }),
  /** Poll until a unix socket at `path` (default: the endpoint socket) accepts a connection. */
  z.object({
    kind: z.literal("socket"),
    path: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(1_800_000).default(600_000),
  }),
]);

const EndpointInvokeSchema = z.discriminatedUnion("kind", [
  /** `POST http://127.0.0.1:<port><path>` with a JSON body per manifest item. */
  z.object({
    kind: z.literal("http-json"),
    path: z.string().regex(/^\//).default("/invoke"),
    timeoutMs: z.number().int().positive().max(1_800_000).default(120_000),
  }),
  /**
   * Length-prefixed MessagePack over a unix socket (the env-server wire the
   * Alpamayo adapter speaks). Registered so descriptors round-trip; the
   * openloop executor does not speak it yet and fails an attempt that needs it
   * with `endpoint_transport_unsupported`.
   */
  z.object({
    kind: z.literal("unix-msgpack"),
    op: z.string().min(1).default("act"),
  }),
]);

export const ModelEndpointDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("process"),
    /** argv the worker spawns; argv[0] resolved via PATH. */
    cmd: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string()).default({}),
    /** Env var that receives the port the worker allocated (http invoke only). */
    portEnv: z.string().min(1).default("PORT"),
    /** Unix socket the process serves, when invoke is socket-based. */
    socketPath: z.string().min(1).optional(),
    health: EndpointHealthSchema,
    invoke: EndpointInvokeSchema,
  }),
  z.object({
    kind: z.literal("socket"),
    /** Already-running endpoint; the worker only connects, never spawns. */
    socketPath: z.string().min(1),
    health: EndpointHealthSchema,
    invoke: EndpointInvokeSchema,
  }),
]);

export type ModelEndpointDescriptor = z.infer<typeof ModelEndpointDescriptorSchema>;

export const CreateModelVersionSchema = z.object({
  family: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, "lowercase family slug"),
  name: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(2_000),
  checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex digest"),
  quant: z.enum(MODEL_QUANTS).default("none"),
  license: z.string().trim().min(1).max(200).default("unknown"),
});
export type CreateModelVersionInput = z.infer<typeof CreateModelVersionSchema>;

export const CreateModelEndpointSchema = z.object({
  modelVersionId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  descriptor: ModelEndpointDescriptorSchema,
});
export type CreateModelEndpointInput = z.infer<typeof CreateModelEndpointSchema>;

/**
 * Run parameters are the SHARED evaluation contracts, not registry-local
 * shapes: `openloop` runs carry `simforge.openloop-params/v2` and
 * `policy_episode` runs carry `simforge.policy-episode-params/v1`, exactly as
 * the cloud job does. Importing them (rather than restating them) is what
 * keeps a desktop run and a cloud run of the same input identical.
 *
 * The `@simforge-oss/evaluation/params` subpath is dependency-free apart from
 * zod, so this module stays safe for the browser bundle.
 */
// Imported, not only re-exported: the submission guard below VALIDATES with
// these, and a re-export alone does not bring them into this module's scope.
import {
  OpenloopParamsSchema,
  PolicyEpisodeParamsSchema,
} from "@simforge-oss/evaluation/params";

export {
  OpenloopParamsSchema,
  PolicyEpisodeParamsSchema as PolicyEpisodeRunParamsSchema,
  OPENLOOP_PARAMS_SCHEMA,
  POLICY_EPISODE_PARAMS_SCHEMA,
  EPISODE_MODES,
  INPUT_KINDS,
  REFUSAL_CODES,
  type OpenloopParams,
  type PolicyEpisodeParams as PolicyEpisodeRunParams,
  type EpisodeMode,
  type InputKind,
} from "@simforge-oss/evaluation/params";

export const CreateModelRunSchema = z.object({
  modelVersionId: z.string().min(1),
  endpointId: z.string().min(1),
  kind: z.enum(MODEL_RUN_KINDS),
  params: z.record(z.unknown()).default({}),
  seed: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().min(1).max(20).default(3),
}).superRefine((value, ctx) => {
  // Reject an unrunnable run at submission instead of burning attempts on it.
  if (value.kind === "openloop") {
    const parsed = OpenloopParamsSchema.safeParse(value.params);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params"],
        message: `openloop params invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      });
    }
    return;
  }
  if (value.kind === "policy_episode") {
    const parsed = PolicyEpisodeParamsSchema.safeParse(value.params);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params"],
        message: `policy_episode params invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      });
    }
    if (parsed.success && !parsed.data.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "spec"],
        message: "a host episode needs a local `spec` path (roles exist only for cloud jobs)",
      });
    }
  }
});
export type CreateModelRunInput = z.infer<typeof CreateModelRunSchema>;

export const PromoteModelVersionSchema = z.object({
  runId: z.string().min(1),
});

export type ModelVersionRecord = {
  id: string;
  family: string;
  name: string;
  source: string;
  checkpointDigest: string;
  quant: string;
  license: string;
  status: string;
  promotedRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelEndpointRecord = {
  id: string;
  modelVersionId: string;
  name: string;
  kind: "process" | "socket";
  descriptor: ModelEndpointDescriptor;
  enabled: boolean;
  createdAt: string;
};

export type ModelRunRecord = {
  id: string;
  modelVersionId: string;
  endpointId: string;
  kind: ModelRunKind;
  status: "queued" | "running" | "succeeded" | "failed";
  params: Record<string, unknown>;
  seed: number;
  resolvedDescriptor: ModelEndpointDescriptor | null;
  metrics: Record<string, unknown> | null;
  outputRefs: unknown[];
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type ModelRunAttemptRecord = {
  id: string;
  runId: string;
  attemptNumber: number;
  workerId: string;
  state: "active" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorDetail: Record<string, unknown> | null;
};

export type ModelRunEventRecord = {
  id: string;
  runId: string;
  attemptId: string | null;
  eventOrdinal: number;
  eventType: string;
  eventPayload: Record<string, unknown>;
  occurredAt: string;
};
