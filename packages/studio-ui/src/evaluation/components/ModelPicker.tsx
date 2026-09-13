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

import * as stylex from "@stylexjs/stylex";
import { Cloud, HardDrive, Info } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import { styles as s } from "./evaluation-components.stylex";
import type { ModelFamilyId, ModelQuant } from "../model-catalog";
import { MODEL_CATALOG, MODEL_FAMILIES } from "../model-catalog";
import type { ExecutionTarget, HostExecutionSnapshot, ModelRuntimeSnapshot } from "../presentation";
import { executionOffers, formatBytes, highestOfferedQuant, runtimeKey } from "../presentation";
import { SelectMenu } from "../../components/ui/select-menu";

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
    <section {...stylex.props(s.section5)} data-testid="evaluation-model-step">
      <div {...stylex.props(families.length === 2 ? s.familyGrid2 : s.familyGrid3)}>
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
              {...stylex.props(s.buttonCard, active && s.buttonCardActive, disabled && s.buttonCardDisabled)}
            >
              <span {...stylex.props(s.textSm, s.fontSemibold, s.textFg)}>{candidate.displayName}</span>
              <span {...stylex.props(s.textXs, s.textMuted)}>
                {formatBytes(candidate.approxWeightsBytes)} weights ·{" "}
                {uploadedVideo ? "trajectory + reasoning" : candidate.capabilities.vqa ? "trajectory + text" : "trajectory only"}
              </span>
              <span {...stylex.props(s.flexWrapGap15)}>
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

      <div {...stylex.props(s.familyGrid2Gap4)}>
        <div {...stylex.props(s.stack15)}>
          <label {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)} htmlFor="quant">
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
          <p {...stylex.props(s.textXs, s.textMuted)}>{cloudOnly
            ? "Runs on a managed GPU. No local model download or Hugging Face token is required."
            : entry.quants.find((offer) => offer.quant === selection.quant)?.note}</p>
        </div>

        <dl {...stylex.props(s.space1, s.textXs, s.textMuted)}>
          <div {...stylex.props(s.flexNoAlignGap2)}>
            <dt {...stylex.props(s.width24, s.shrink0, s.uppercaseWide)}>Revision</dt>
            <dd {...stylex.props(s.min0, s.truncate, s.mono, s.textFg)}>{entry.weightsRevision}</dd>
          </div>
          <div {...stylex.props(s.flexNoAlignGap2)}>
            <dt {...stylex.props(s.width24, s.shrink0, s.uppercaseWide)}>Cameras</dt>
            <dd {...stylex.props(s.textFg)}>
              {uploadedVideo
                ? "1–7 uploaded views, mapped below"
                : entry.cameras.required
                  ? `exactly [${entry.cameras.required.join(", ")}]`
                  : `variable, default [${entry.cameras.default.join(", ")}]`}
            </dd>
          </div>
          <div {...stylex.props(s.flexNoAlignGap2)}>
            <dt {...stylex.props(s.width24, s.shrink0, s.uppercaseWide)}>License</dt>
            <dd {...stylex.props(s.textFg)}>
              {entry.license.id}
              {entry.license.commercialUseReviewRequired ? " · commercial use needs review" : ""}
            </dd>
          </div>
        </dl>
      </div>

      {entry.license.cardConflictNote ? (
        <p {...stylex.props(s.flexNoAlignGap2, s.textXs, s.leading5, s.textMuted)}>
          <Info aria-hidden="true" {...stylex.props(s.mt05, s.iconSm)} />
          {entry.license.cardConflictNote}
        </p>
      ) : null}

      <fieldset {...stylex.props(s.space2)} data-testid="execution-target">
        <legend {...stylex.props(s.textXs, s.uppercaseWide, s.textMuted)}>
          Where it runs
        </legend>
        {offers.map((offer) => {
          const meta = TARGET_META[offer.target];
          const Icon = meta.icon;
          const active = selection.target === offer.target;
          return (
            <label
              key={offer.target}
              {...stylex.props(s.targetCard, active && s.targetCardActive, !offer.available && s.targetCardUnavailable)}
            >
              <input
                type="radio"
                name="execution-target"
                {...stylex.props(s.mt1)}
                checked={active}
                disabled={disabled || !offer.available}
                onChange={() => onChange({ ...selection, target: offer.target })}
              />
              <span {...stylex.props(s.targetBody)}>
                <span {...stylex.props(s.targetTitle)}>
                  <Icon aria-hidden="true" {...stylex.props(s.iconPlain)} />
                  {meta.label}
                  {offer.qualification === "qualification-pending" ? (
                    <Badge variant="outline">Qualification pending</Badge>
                  ) : null}
                  {offer.qualification === "unsupported" ? (
                    <Badge variant="outline">Not supported here</Badge>
                  ) : null}
                </span>
                <span {...stylex.props(s.targetDesc)}>
                  {meta.description}
                </span>
                {offer.target === "local" && offer.available && localVramGiB !== null ? (
                  <span {...stylex.props(s.targetDesc, s.mt1)}>
                    The measured profile needs about {localVramGiB} GiB of device memory with
                    nothing else resident. Another process holding the GPU fails the run with an
                    out-of-memory error rather than degrading it.
                  </span>
                ) : null}
                {offer.reasons.length > 0 ? (
                  <ul {...stylex.props(s.targetReason)}>
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
