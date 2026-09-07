/**
 * Job parameter builders.
 *
 * SimCloud treats `params` as an opaque passthrough — it only size-caps it — so
 * this document is the contract between the UI and the evaluation worker:
 * `simforge.openloop-params/v2`, owned by `@simforge-oss/evaluation`.
 *
 * One schema covers trajectory and text runs (`task: 'act' | 'text'`), because
 * they produce one result document and are validated by one validator. Nothing
 * is defaulted into existence here: a sampling knob the user did not choose is
 * omitted so the worker's own default, and its provenance, stay authoritative.
 *
 * For cloud jobs the artifact list in SimCloud's `inputs[]` is authoritative, so
 * each params item names its `role` and omits `ref`. The worker's schema
 * requires exactly one of the two, which makes a duplicated pair a validation
 * failure rather than a silent disagreement.
 */

import { OPENLOOP_PARAMS_SCHEMA } from "./contracts";
import type { ModelCatalogEntry } from "./model-catalog";

/** Text task names as the evaluation protocol spells them. */
export type TextTask = "vqa" | "meta_actions" | "autolabel" | "grounding";

/** Maps a family's upstream task name onto the protocol's name. */
const UPSTREAM_TEXT_TASKS: Record<string, TextTask> = {
  vqa: "vqa",
  meta_action: "meta_actions",
  meta_actions: "meta_actions",
  auto_labeling: "autolabel",
  autolabel: "autolabel",
  grounding: "grounding",
};

export type OpenLoopSampling = {
  numTrajSamples: number;
  topP?: number;
  temperature?: number;
  diffusionSteps?: number;
  /** Navigation instruction, only for families whose `capabilities.nav` is true. */
  navText?: string;
};

export type OpenLoopItemKind =
  | "scenario"
  | "dataset-clip"
  | "user-clip"
  | "replay-context"
  | "trace";

export type OpenLoopParamsItem = {
  kind: OpenLoopItemKind;
  /** Cloud jobs: the SimCloud `inputs[]` role naming this item's artifact. */
  role?: string;
  /** Host-local runs only: a path, instance id or `clipId:t0Us`. */
  ref?: string;
  cameraProfile: string | null;
  t0Us?: number;
};

export const DEFAULT_HORIZONS_S: readonly number[] = [1, 3, 6.4];

export type BuildParamsInput = {
  items: OpenLoopParamsItem[];
  /**
   * `auto` scores only when the input bundle itself carried a reference future;
   * `none` forbids scoring. Neither ever synthesizes a reference.
   */
  reference: "auto" | "none";
  sampling: OpenLoopSampling;
  task: "act" | "text";
  textTask?: TextTask | null;
  prompt?: string | null;
  horizonsS?: readonly number[];
  seed: number;
  ood?: {
    exploratory?: boolean;
    assumedStationaryEgo?: boolean;
    assumedIntrinsics?: boolean;
  };
};

/**
 * Build a `simforge.openloop-params/v2` document.
 *
 * Named rather than inlined because it is the single place the wire shape is
 * spelled: both hosts, both job kinds and the estimate call all go through it,
 * so a protocol change has exactly one edit site.
 */
export function buildOpenLoopParams(input: BuildParamsInput): Record<string, unknown> {
  const sampling: Record<string, unknown> = { numTrajSamples: input.sampling.numTrajSamples };
  if (input.sampling.topP !== undefined) sampling.topP = input.sampling.topP;
  if (input.sampling.temperature !== undefined) sampling.temperature = input.sampling.temperature;
  if (input.sampling.diffusionSteps !== undefined) {
    sampling.diffusionSteps = input.sampling.diffusionSteps;
  }
  if (input.sampling.navText) sampling.navText = input.sampling.navText;

  return {
    schema: OPENLOOP_PARAMS_SCHEMA,
    items: input.items.map((item) => {
      const entry: Record<string, unknown> = { kind: item.kind, cameraProfile: item.cameraProfile };
      if (item.role !== undefined) entry.role = item.role;
      else if (item.ref !== undefined) entry.ref = item.ref;
      if (item.t0Us !== undefined) entry.t0Us = item.t0Us;
      return entry;
    }),
    sampling,
    reference: input.reference,
    task: input.task,
    textTask: input.task === "text" ? (input.textTask ?? null) : null,
    prompt: input.task === "text" ? (input.prompt ?? null) : null,
    horizonsS: [...(input.horizonsS ?? DEFAULT_HORIZONS_S)],
    seed: input.seed,
    ood: {
      exploratory: input.ood?.exploratory ?? false,
      assumedStationaryEgo: input.ood?.assumedStationaryEgo ?? false,
      assumedIntrinsics: input.ood?.assumedIntrinsics ?? false,
    },
  };
}

/**
 * The text tasks a family can actually perform, translated from its upstream
 * task names into the protocol's names.
 */
export function availableTextTasks(entry: ModelCatalogEntry): TextTask[] {
  const tasks: TextTask[] = [];
  for (const upstream of entry.textTasks) {
    const mapped = UPSTREAM_TEXT_TASKS[upstream];
    if (mapped && !tasks.includes(mapped)) tasks.push(mapped);
  }
  return tasks;
}

export const TEXT_TASK_LABELS: Record<TextTask, string> = {
  vqa: "Ask a question about the scene",
  meta_actions: "Predict meta actions",
  autolabel: "Auto-label the scene",
  grounding: "Ground a referring expression",
};

/**
 * Free text in a params document that the control plane will refuse.
 *
 * The worker never dereferences anything from customer params, so the control
 * plane rejects any string that looks like a URL or a filesystem path — which
 * includes a question a user typed. Checked here so the user gets that
 * explanation next to the field instead of an opaque `invalid_job` after the
 * upload and the estimate are already done.
 */
const URL_OR_PATH_SHAPED = /(^|\s)(?:[a-z][a-z0-9+.-]*:\/\/|\/{1,2}[^\s]|[a-z]:\\|\.{1,2}\/)/i;

export function pathShapedRefusal(field: string, value: string): string | null {
  if (!URL_OR_PATH_SHAPED.test(value)) return null;
  return `${field} looks like a URL or a file path. Job parameters cannot contain either: the worker never fetches or opens anything named in them, so the run would be refused. Describe what you want in words instead.`;
}
