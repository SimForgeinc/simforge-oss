"use client";

/**
 * Step 2 — choose a model, a precision and where it runs.
 *
 * Callers may show the complete model-store catalog or a focused subset. A
 * family the machine cannot execute is shown with the runtime probe's own
 * reasons and remains selectable for cloud execution, because downloading a
 * model and being able to run it are separate questions.
 *
 * The backend is the authority: a family the workspace is not entitled to is
 * refused at submit with `model_not_available_for_workspace`, and that refusal
 * is displayed verbatim rather than pre-guessed here.
 */

import { Cloud, HardDrive, Info } from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { SelectMenu } from "../../components/ui/select-menu";
import type { ModelFamilyId, ModelQuant } from "../model-catalog";
import { MODEL_CATALOG, MODEL_FAMILIES } from "../model-catalog";
import type { ExecutionTarget, HostExecutionSnapshot, ModelRuntimeSnapshot } from "../presentation";
import { executionOffers, formatBytes, highestOfferedQuant, runtimeKey } from "../presentation";

export type ModelSelection = {
  family: ModelFamilyId;
  quant: ModelQuant;
  target: ExecutionTarget;
};

const TARGET_META: Record<ExecutionTarget, { label: string; description: string; icon: typeof Cloud }> = {
  local: {
    label: "This machine",
    description:
      "Runs on your GPU with the weights you installed. No cloud cost. Queued as a job, not answered interactively — a single inference takes seconds, so a batch takes minutes.",
    icon: HardDrive,
  },
  runpod: {
    label: "Cloud (RunPod)",
    description: "Runs on managed serverless GPUs. No local download required; billed per run.",
    icon: Cloud,
  },
};

export function ModelPicker({
  host,
  runtime,
  selection,
  onChange,
  disabled = false,
  families = MODEL_FAMILIES,
  uploadedVideo = false,
  cloudOnly = false,
}: {
  host: HostExecutionSnapshot;
  /** Desktop only. Null in the browser portal, which has no local model store. */
  runtime: ModelRuntimeSnapshot | null;
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  disabled?: boolean;
  /** Restricts this picker without changing the shared model-store catalog. */
  families?: readonly ModelFamilyId[];
  uploadedVideo?: boolean;
  cloudOnly?: boolean;
}) {
  const entry = MODEL_CATALOG[selection.family];
  const key = runtimeKey(selection.family, selection.quant);
  const allOffers = executionOffers(
    host,
    entry,
    selection.quant,
    runtime?.installs[key] ?? null,
    runtime?.eligibility[key] ?? null,
    runtime ? runtime.prepared[selection.family] ?? null : null,
  );
  const offers = cloudOnly ? allOffers.filter((offer) => offer.target === "runpod") : allOffers;

  // The measured envelope is exclusive-use: the runtime's own requirement, or
  // the catalog's if the probe did not report one.
  const eligibility = runtime?.eligibility[key] ?? null;
  const localVramGiB =
    eligibility?.requires.vramGiB ??
    entry.quants.find((offer) => offer.quant === selection.quant)?.minVramGiB ??
    null;

  const quantOptions = entry.quants.filter((offer) => !cloudOnly || offer.quant === "bf16").map((offer) => ({
    value: offer.quant,
    label:
      offer.status === "supported"
        ? `${offer.quant}${offer.minVramGiB ? ` · ${offer.minVramGiB} GiB VRAM` : ""}`
        : `${offer.quant} · ${offer.status === "unsupported" ? "unsupported" : "pending measurement"}`,
    disabled: offer.status !== "supported",
  }));

  return (
    <section className="space-y-5" data-testid="evaluation-model-step">
      <div className={cn("grid gap-3", families.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
        {families.map((family) => {
          const candidate = MODEL_CATALOG[family];
          const active = family === selection.family;
          return (
            <button
              key={family}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() =>
                onChange({
                  family,
                  quant: cloudOnly ? "bf16" : highestOfferedQuant(family),
                  target: cloudOnly || candidate.remoteOnly ? "runpod" : selection.target,
                })
              }
              className={cn(
                "flex flex-col items-start gap-2 border p-4 text-left transition-colors",
                active
                  ? "border-primary bg-primary/5"
                  : "border-border bg-background hover:bg-accent/40",
                disabled ? "cursor-not-allowed opacity-60" : null,
              )}
              data-testid={`model-choice-${family}`}
            >
              <span className="text-sm font-semibold text-foreground">{candidate.displayName}</span>
              <span className="text-xs text-muted-foreground">
                {formatBytes(candidate.approxWeightsBytes)} weights ·{" "}
                {uploadedVideo ? "trajectory + reasoning" : candidate.capabilities.vqa ? "trajectory + text" : "trajectory only"}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {cloudOnly || candidate.remoteOnly ? (
                  <Badge variant="secondary">Cloud execution</Badge>
                ) : (
                  <Badge variant="outline">Local or cloud</Badge>
                )}
                {candidate.requiresUserHfToken && !cloudOnly ? (
                  <Badge variant="outline">Needs your HF token</Badge>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs uppercase tracking-wide text-muted-foreground" htmlFor="quant">
            Precision
          </label>
          <SelectMenu
            id="quant"
            label="Precision"
            value={selection.quant}
            options={quantOptions}
            disabled={disabled}
            onChange={(value) => onChange({ ...selection, quant: value as ModelQuant })}
          />
          <p className="text-xs text-muted-foreground">
            {cloudOnly
              ? "Runs on a managed GPU. No local model download or Hugging Face token is required."
              : entry.quants.find((offer) => offer.quant === selection.quant)?.note}
          </p>
        </div>

        <dl className="space-y-1 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 uppercase tracking-wide">Revision</dt>
            <dd className="min-w-0 truncate font-mono text-foreground">{entry.weightsRevision}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 uppercase tracking-wide">Cameras</dt>
            <dd className="text-foreground">
              {uploadedVideo
                ? "1–7 uploaded views, mapped below"
                : entry.cameras.required
                  ? `exactly [${entry.cameras.required.join(", ")}]`
                  : `variable, default [${entry.cameras.default.join(", ")}]`}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 uppercase tracking-wide">License</dt>
            <dd className="text-foreground">
              {entry.license.id}
              {entry.license.commercialUseReviewRequired ? " · commercial use needs review" : ""}
            </dd>
          </div>
        </dl>
      </div>

      {entry.license.cardConflictNote ? (
        <p className="flex gap-2 text-xs leading-5 text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {entry.license.cardConflictNote}
        </p>
      ) : null}

      <fieldset className="space-y-2" data-testid="execution-target">
        <legend className="text-xs uppercase tracking-wide text-muted-foreground">
          Where it runs
        </legend>
        {offers.map((offer) => {
          const meta = TARGET_META[offer.target];
          const Icon = meta.icon;
          const active = selection.target === offer.target;
          return (
            <label
              key={offer.target}
              className={cn(
                "flex cursor-pointer items-start gap-3 border p-3",
                active ? "border-primary bg-primary/5" : "border-border",
                offer.available ? null : "cursor-not-allowed opacity-90",
              )}
            >
              <input
                type="radio"
                name="execution-target"
                className="mt-1"
                checked={active}
                disabled={disabled || !offer.available}
                onChange={() => onChange({ ...selection, target: offer.target })}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Icon aria-hidden="true" className="size-4" />
                  {meta.label}
                  {offer.qualification === "qualification-pending" ? (
                    <Badge variant="outline">Qualification pending</Badge>
                  ) : null}
                  {offer.qualification === "unsupported" ? (
                    <Badge variant="outline">Not supported here</Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {meta.description}
                </span>
                {offer.target === "local" && offer.available && localVramGiB !== null ? (
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    The measured profile needs about {localVramGiB} GiB of device memory with
                    nothing else resident. Another process holding the GPU fails the run with an
                    out-of-memory error rather than degrading it.
                  </span>
                ) : null}
                {offer.reasons.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-xs leading-5 text-amber-600 dark:text-amber-500">
                    {offer.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
