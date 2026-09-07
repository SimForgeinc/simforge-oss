"use client";

/**
 * Step 1 — choose an input, classify it honestly, upload it directly.
 *
 * The classification is shown *before* anything is uploaded, because the user
 * needs to know that a bare video buys a text analysis and not a driving score.
 * Bytes go from the browser to storage using an exact-object grant; they are
 * never proxied through the web server.
 */

import { useCallback, useRef, useState } from "react";
import { CheckCircle2, FileVideo, Loader2, Upload, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { RefusalNotice } from "./RefusalNotice";
import type { EvaluationGateway } from "../gateway";
import { ComputeApiError } from "../gateway";
import type { UploadedArtifact, UploadProgress } from "../upload";
import { uploadEvaluationInput } from "../upload";
import { classifyEvaluationInput, type EvaluationInputClass } from "../input-kinds";
import type { ModelCatalogEntry } from "../model-catalog";
import { formatBytes } from "../presentation";

export type PreparedInput = {
  artifacts: UploadedArtifact[];
  classification: EvaluationInputClass;
  cameraProfile: string | null;
  /** Files, in the order their artifacts were produced. */
  files: { name: string; bytes: number }[];
};

const MANIFEST_NAME_PATTERN = /(^|[.\/])((clip|scene|replay-context|manifest)\.json)$/i;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

function classificationSummary(classification: EvaluationInputClass): {
  headline: string;
  body: string;
} {
  switch (classification.kind) {
    case "driving-clip":
      return classification.scoreable
        ? {
            headline: "Driving clip with a reference future",
            body: "Open-loop prediction can be scored against the recorded future. ADE/FDE will be reported with the horizon, sample count and coordinate convention.",
          }
        : {
            headline: "Driving clip without a reference future",
            body: "Open-loop prediction can run, but there is nothing to score it against. The result will be a prediction, explicitly unscored.",
          };
    case "bundle-unverified":
      return {
        headline: "Bundle — contents verified on the server",
        body: classification.reason,
      };
    case "video-only":
      return {
        headline: "Video only",
        body: "A video supports the model's text analysis tasks. It is not a driving input, so no trajectory score is possible from it.",
      };
    case "incomplete":
      return {
        headline: "Incomplete driving input",
        body: "This bundle does not carry everything an open-loop run needs.",
      };
    case "unsupported":
      return { headline: "Unsupported input", body: classification.reason };
  }
}

export function InputPicker({
  gateway,
  model,
  prepared,
  onPrepared,
  onCleared,
  disabled = false,
}: {
  gateway: EvaluationGateway;
  model: ModelCatalogEntry;
  prepared: PreparedInput | null;
  onPrepared: (input: PreparedInput) => void;
  onCleared: () => void;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState<unknown>(undefined);
  const [classification, setClassification] = useState<EvaluationInputClass | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = useCallback(
    async (selected: File[]) => {
      setError(null);
      setProgress(null);
      onCleared();

      const manifestFile = selected.find((file) => MANIFEST_NAME_PATTERN.test(file.name));
      const payloadFiles = selected.filter((file) => file !== manifestFile);
      let manifestDocument: unknown = undefined;
      if (manifestFile) {
        try {
          manifestDocument = JSON.parse(await manifestFile.text());
        } catch {
          setError(
            `${manifestFile.name} is not valid JSON, so this input cannot be classified. Fix the manifest or select the bundle archive instead.`,
          );
          return;
        }
      }

      const primary = payloadFiles[0] ?? manifestFile;
      if (!primary) return;
      const oversized = payloadFiles.find((file) => file.size > MAX_UPLOAD_BYTES);
      if (oversized) {
        setError(
          `${oversized.name} is ${formatBytes(oversized.size)}. The upload limit for a single object is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
        );
        return;
      }

      setFiles(payloadFiles.length > 0 ? payloadFiles : [primary]);
      setManifest(manifestDocument);
      setClassification(classifyEvaluationInput(primary, model, manifestDocument));
    },
    [model, onCleared],
  );

  const upload = useCallback(async () => {
    if (files.length === 0 || !classification) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);

    try {
      const artifacts: UploadedArtifact[] = [];
      for (const file of files) {
        const artifact = await uploadEvaluationInput(gateway, file, {
          purpose: classification.kind === "video-only" ? "video" : "eval-clip",
          signal: controller.signal,
          onProgress: setProgress,
        });
        artifacts.push(artifact);
      }
      const cameraProfile =
        classification.kind === "driving-clip"
          ? `cameras:${classification.probe.cameraIds.join(",")}`
          : null;
      onPrepared({
        artifacts,
        classification,
        cameraProfile,
        files: files.map((file) => ({ name: file.name, bytes: file.size })),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        setProgress(null);
        return;
      }
      setError(
        cause instanceof ComputeApiError
          ? cause.message
          : `The upload could not be completed: ${String(cause)}`,
      );
    } finally {
      abortRef.current = null;
    }
  }, [files, classification, gateway, onPrepared]);

  const clear = () => {
    abortRef.current?.abort();
    setFiles([]);
    setManifest(undefined);
    setClassification(null);
    setProgress(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    onCleared();
  };

  const summary = classification ? classificationSummary(classification) : null;
  const uploading = progress !== null && progress.phase !== "done" && prepared === null;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <section className="space-y-4" data-testid="evaluation-input-step">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,.zip,.tar,.tgz,.json"
          className="hidden"
          onChange={(event) => void select(Array.from(event.target.files ?? []))}
          data-testid="evaluation-file-input"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload aria-hidden="true" />
          {files.length > 0 ? "Choose different files" : "Choose clip or video"}
        </Button>
        {files.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            <X aria-hidden="true" />
            Clear
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            A clip bundle plus its manifest, or a plain video. Select the manifest together with the
            media to have the clip classified before upload.
          </p>
        )}
      </div>

      {files.length > 0 ? (
        <ul className="divide-y divide-border border border-border" data-testid="evaluation-file-list">
          {files.map((file) => (
            <li key={file.name} className="flex items-center gap-3 px-3 py-2 text-sm">
              <FileVideo aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatBytes(file.size)}
              </span>
            </li>
          ))}
          {manifest !== undefined ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Manifest read locally; the server re-validates the bundle before the run.
            </li>
          ) : null}
        </ul>
      ) : null}

      {summary && classification ? (
        <div
          className={cn(
            "border p-4",
            classification.kind === "driving-clip" && classification.scoreable
              ? "border-border bg-muted/20"
              : "border-border bg-muted/10",
          )}
          data-testid="evaluation-input-classification"
        >
          <p className="text-sm font-semibold text-foreground">{summary.headline}</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{summary.body}</p>
          {classification.kind === "driving-clip" ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
              <div>
                <dt className="uppercase tracking-wide">Cameras</dt>
                <dd className="text-foreground">[{classification.probe.cameraIds.join(", ")}]</dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Calibration</dt>
                <dd className="text-foreground">present</dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Reference</dt>
                <dd className="text-foreground">
                  {classification.scoreable ? "recorded future" : "none"}
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Items</dt>
                <dd className="text-foreground">{classification.probe.itemCount}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      ) : null}

      {classification?.kind === "incomplete" ? (
        <RefusalNotice
          title="This input cannot be scored as a driving clip"
          missing={classification.missing}
        />
      ) : null}
      {classification?.kind === "driving-clip" && classification.modelMismatch.length > 0 ? (
        <RefusalNotice
          tone="warn"
          title={`Camera set does not match ${model.displayName}`}
          reasons={classification.modelMismatch}
        />
      ) : null}
      {classification?.kind === "unsupported" ? (
        <RefusalNotice title="Unsupported input" reasons={[classification.reason]} />
      ) : null}
      {error ? <RefusalNotice title="Upload failed" reasons={[error]} /> : null}

      {progress && progress.phase !== "done" ? (
        <div className="space-y-2" data-testid="evaluation-upload-progress">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {progress.phase === "hashing"
                ? "Checksumming locally"
                : progress.phase === "reserving"
                  ? "Requesting a storage grant"
                  : progress.phase === "completing"
                    ? "Server verifying stored bytes"
                    : "Uploading to storage"}
              {progress.parts ? ` · part ${progress.parts.done + 1}/${progress.parts.total}` : ""}
            </span>
            <span className="tabular-nums">
              {formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)}
            </span>
          </div>
          <div className="h-1.5 w-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{
                width: `${progress.bytesTotal > 0 ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {prepared ? (
        <p
          className="inline-flex items-center gap-2 text-sm text-foreground"
          data-testid="evaluation-input-ready"
        >
          <CheckCircle2 aria-hidden="true" className="size-4 text-primary" />
          {prepared.artifacts.length} object{prepared.artifacts.length === 1 ? "" : "s"} stored and
          verified{prepared.artifacts.some((artifact) => artifact.deduplicated) ? " (already held by this workspace)" : ""}.
        </p>
      ) : (
        <Button
          type="button"
          disabled={
            disabled ||
            uploading ||
            files.length === 0 ||
            classification === null ||
            classification.kind === "unsupported"
          }
          onClick={() => void upload()}
          data-testid="evaluation-upload-button"
        >
          {uploading ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Upload {files.length > 1 ? `${files.length} objects` : "input"}
          {totalBytes > 0 ? ` (${formatBytes(totalBytes)})` : ""}
        </Button>
      )}
    </section>
  );
}
