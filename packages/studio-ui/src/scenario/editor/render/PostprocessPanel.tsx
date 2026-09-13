"use client";

import { useStudioHost } from "../../../host";
import { StudioHostRequestError, type PresignedArtifact } from "@simforge-oss/studio-host";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Sparkles } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SelectMenuField } from "../../../components/ui/select-menu";
import { Textarea } from "../../../components/ui/textarea";
import { useVisiblePolling } from "../../../lib/use-visible-polling";
import { useScenarioNotification } from "../status";
import { RenderProgressBar, RenderStateChip } from "./RenderStatePieces";
import {
  formatTimestamp,
  hasLiveJob,
  humanizeCode,
  postprocessIdempotencyKey,
  postprocessSourceCandidates,
} from "./render-view-model";
import type {
  ScenarioGalleryItemDto,
  ScenarioRenderJobState,
} from "@simforge-oss/studio-host";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./PostprocessPanel.stylex";

/**
 * Cosmos augment (#139, #144) and VLM annotate (#140, #145), reshaped onto v2's control plane.
 *
 * v1 had `CosmosWorkspace` (983 LOC) and `PostprocessWorkspace` (718) over a separate `cosmos_jobs`
 * table with its own queue, its own polling and its own artifact plumbing. v2's 20260805016000 made a
 * postprocess run a render job with a different `job_mode`, a parent pointer and a hashed model config
 * — so it inherits fenced leases, ordinal job events, checksum-bound uploads and the artifact cleanup
 * outbox for free. That collapse is why this is one panel and not two workspaces: the only thing that
 * differs between Cosmos and VLM is which fields the form collects.
 *
 * Both submit through the same idempotency key, derived from the run's identity rather than a clock,
 * so a double-click resolves to the same job instead of queueing two GPU runs.
 */

type PostprocessMode = "cosmos_augment" | "vlm_annotate";

const MODE_COPY: Record<
  PostprocessMode,
  { title: string; verb: string; family: string; families: string[]; promptLabel: string; promptHint: string }
> = {
  cosmos_augment: {
    title: "Cosmos augment",
    verb: "Augment",
    family: "cosmos-transfer",
    families: ["cosmos-transfer", "cosmos-predict"],
    promptLabel: "Prompt",
    promptHint: "Describe the world to transfer this render into.",
  },
  vlm_annotate: {
    title: "VLM annotate",
    verb: "Analyze",
    family: "cosmos-reason",
    families: ["cosmos-reason", "qwen-vl"],
    promptLabel: "Question",
    promptHint: "Ask what the model should report about this clip.",
  },
};

const POLL_INTERVAL_MS = 6000;

export function PostprocessPanel({
  parentJobId,
  parentState,
  artifacts,
}: {
  parentJobId: string;
  parentState: ScenarioRenderJobState;
  artifacts: readonly PresignedArtifact[];
}) {
  const studioHost = useStudioHost();
  const [children, setChildren] = useState<ScenarioGalleryItemDto[]>([]);
  const [openMode, setOpenMode] = useState<PostprocessMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const items = await studioHost.jobs.listPostprocessChildren(parentJobId, signal);
        if (!signal?.aborted) setChildren(items);
      } catch {
        // A failed children read leaves the previous list on screen. It is a derived list beside the
        // render's own files; replacing it with an error would hide output that is already there.
      }
    },
    [parentJobId, studioHost],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const poll = useCallback(() => load(), [load]);
  useVisiblePolling(poll, POLL_INTERVAL_MS, hasLiveJob(children));

  const sources = useMemo(() => postprocessSourceCandidates(artifacts), [artifacts]);
  // The check the server enforces, mirrored so the button explains itself instead of failing: the
  // parent must have succeeded and must have an available video output to feed in.
  const blocked =
    parentState !== "succeeded"
      ? "Postprocessing needs a render that has finished successfully."
      : sources.length === 0
        ? "This render has no available video output to postprocess."
        : null;

  useScenarioNotification(
    `scenario-postprocess:${parentJobId}`,
    error
      ? { severity: "error", source: "postprocess", message: error, action: null }
      : null,
  );

  const cosmosChildren = children.filter((child) => child.jobMode === "cosmos_augment");
  const vlmChildren = children.filter((child) => child.jobMode === "vlm_annotate");

  return (
    <section {...stylex.props(styles.flexColRuleT)}>
      <div {...stylex.props(styles.flexCenterGap2)}>
        <h4 {...stylex.props(styles.capsMicroMuted)}>
          Postprocess
        </h4>
        <div {...stylex.props(styles.flexCenterPushRight)}>
          <Button
            disabled={Boolean(blocked)}
            onClick={() => setOpenMode((current) => (current === "cosmos_augment" ? null : "cosmos_augment"))}
            size="sm"
            title={blocked ?? undefined}
            variant="outline"
          >
            <Sparkles aria-hidden="true" className={stylex.props(styles.size35).className} />
            Cosmos
          </Button>
          <Button
            disabled={Boolean(blocked)}
            onClick={() => setOpenMode((current) => (current === "vlm_annotate" ? null : "vlm_annotate"))}
            size="sm"
            title={blocked ?? undefined}
            variant="outline"
          >
            <Bot aria-hidden="true" className={stylex.props(styles.size35).className} />
            VLM
          </Button>
        </div>
      </div>

      {blocked ? <p {...stylex.props(styles.microMuted)}>{blocked}</p> : null}

      {openMode && !blocked ? (
        <PostprocessForm
          key={openMode}
          mode={openMode}
          parentJobId={parentJobId}
          sources={sources}
          onError={setError}
          onSubmitted={() => {
            setOpenMode(null);
            setError(null);
            void load();
          }}
        />
      ) : null}

      <ChildList items={cosmosChildren} title="Cosmos runs" />
      <ChildList items={vlmChildren} title="VLM runs" />
    </section>
  );
}

function ChildList({ items, title }: { items: ScenarioGalleryItemDto[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <div {...stylex.props(styles.flexColGap1)}>
      <h5 {...stylex.props(styles.capsMicroMuted2)}>
        {title} · {items.length}
      </h5>
      <ul {...stylex.props(styles.borderedDivided)}>
        {items.map((child, index) => (
          <li {...stylex.props(styles.flexColGap12, index > 0 && styles.rowDivided)} key={child.id}>
            <div {...stylex.props(styles.flexCenterGap2)}>
              <RenderStateChip state={child.jobState} />
              <span {...stylex.props(styles.fillXsInk)}>
                {child.modelFamily ?? "—"}
              </span>
              <span {...stylex.props(styles.tightMicroMuted)}>
                {child.artifactCount} {child.artifactCount === 1 ? "file" : "files"}
              </span>
            </div>
            <RenderProgressBar
              label={`${child.modelFamily ?? "Postprocess"} progress`}
              progressPercent={child.progressPercent}
              state={child.jobState}
            />
            <span {...stylex.props(styles.microMuted)}>
              {formatTimestamp(child.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PostprocessForm({
  mode,
  parentJobId,
  sources,
  onSubmitted,
  onError,
}: {
  mode: PostprocessMode;
  parentJobId: string;
  sources: readonly { id: string; artifactKind: string }[];
  onSubmitted: () => void;
  onError: (message: string | null) => void;
}) {
  const studioHost = useStudioHost();
  const copy = MODE_COPY[mode];
  const [sourceArtifactId, setSourceArtifactId] = useState(sources[0]?.id ?? "");
  const [modelFamily, setModelFamily] = useState(copy.family);
  const [prompt, setPrompt] = useState("");
  const [guidance, setGuidance] = useState("7");
  const [busy, setBusy] = useState(false);

  const sourceOptions = useMemo(
    () => sources.map((artifact) => ({ value: artifact.id, label: artifact.artifactKind })),
    [sources],
  );

  const canSubmit = Boolean(sourceArtifactId) && prompt.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    onError(null);
    // `modelConfig` doubles as the render spec for a postprocess run, and its canonical hash is what
    // the closure check binds. Only fields the model actually consumes go in — anything else changes
    // the digest and so makes an identical run look like a different one.
    const modelConfig: Record<string, unknown> = {
      prompt: prompt.trim(),
      ...(mode === "cosmos_augment" ? { guidance: Number(guidance) || 7 } : {}),
    };
    try {
      await studioHost.jobs.createPostprocessJob({
        parentRenderJobId: parentJobId,
        sourceArtifactId,
        jobMode: mode,
        modelFamily,
        modelConfig,
        idempotencyKey: postprocessIdempotencyKey({
          parentRenderJobId: parentJobId,
          sourceArtifactId,
          jobMode: mode,
          modelFamily,
          modelConfig,
        }),
      });
      onSubmitted();
    } catch (cause) {
      onError(
        cause instanceof StudioHostRequestError
          ? POSTPROCESS_ERRORS[cause.code] ?? humanizeCode(cause.code)
          : `The ${copy.title.toLowerCase()} run could not be queued.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      {...stylex.props(styles.flexColBordered)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p {...stylex.props(styles.capsMicroMuted)}>
        {copy.title}
      </p>
      <SelectMenuField
        label="Source clip"
        labelXstyle={styles.fieldMetaLabel}
        onChange={setSourceArtifactId}
        options={sourceOptions}
        value={sourceArtifactId}
      />
      <SelectMenuField
        label="Model"
        labelXstyle={styles.fieldMetaLabel}
        onChange={setModelFamily}
        options={copy.families}
        value={modelFamily}
      />
      <label {...stylex.props(styles.flexColGap1)}>
        <span {...stylex.props(styles.capsMicroMuted2)}>
          {copy.promptLabel}
        </span>
        <Textarea
          xstyle={styles.xs}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={copy.promptHint}
          value={prompt}
        />
      </label>
      {mode === "cosmos_augment" ? (
        <label {...stylex.props(styles.flexColGap1)}>
          <span {...stylex.props(styles.capsMicroMuted2)}>Guidance</span>
          <Input
            xstyle={styles.xs2}
            inputMode="numeric"
            onChange={(event) => setGuidance(event.target.value)}
            value={guidance}
          />
        </label>
      ) : null}
      <Button xstyle={styles.selfStart} disabled={!canSubmit} size="sm" type="submit">
        {busy ? "Queueing…" : `${copy.verb} render`}
      </Button>
    </form>
  );
}

/**
 * Route error codes to sentences.
 *
 * These two are the ones a user can actually resolve, and they are indistinguishable from each other
 * as a generic failure — one means "wait", the other means "pick a different file".
 */
const POSTPROCESS_ERRORS: Record<string, string> = {
  parent_not_succeeded: "That render has not finished successfully yet.",
  source_artifact_unavailable: "That clip is not available to postprocess. Pick another file.",
  dataset_action_denied: "You do not have permission to postprocess in this dataset.",
};
