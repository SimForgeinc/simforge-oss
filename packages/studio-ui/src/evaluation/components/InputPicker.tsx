"use client";

/**
 * Selects one ordinary video or a synchronized set of camera recordings and
 * uploads every selected file exactly once. Camera identity and timing are
 * configured after the verified uploads, without transferring the bytes again.
 */

import { useCallback, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../../components/ui/button";
import { CheckCircle2, FileVideo, Loader2, Upload, X } from "lucide-react";
import { styles as s } from "./evaluation-components.stylex";
import type { EvaluationGateway } from "../gateway";
import { ComputeApiError } from "../gateway";
import { classifyEvaluationInput, type EvaluationInputClass } from "../input-kinds";
import type { ModelCatalogEntry } from "../model-catalog";
import { formatBytes } from "../presentation";
import type { ExecutionTarget } from "../presentation";
import { RefusalNotice } from "./RefusalNotice";
import type { UploadedArtifact, UploadProgress } from "../upload";
import { uploadEvaluationInput } from "../upload";

export type PreparedInput = {
  /** Empty for a local run: nothing is uploaded, so no artifact exists. */
  artifacts: UploadedArtifact[];
  classification: EvaluationInputClass;
  cameraProfile: string | null;
  /** Files in exactly the same order as artifacts and the submitted inputs. */
  files: { name: string; bytes: number }[];
  sourceFiles: File[];
};

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_CAMERAS = 7;

export function InputPicker({
  gateway,
  model,
  prepared,
  onPrepared,
  onCleared,
  disabled = false,
  execution = "runpod",
}: {
  gateway: EvaluationGateway;
  model: ModelCatalogEntry;
  prepared: PreparedInput | null;
  onPrepared: (input: PreparedInput) => void;
  onCleared: () => void;
  disabled?: boolean;
  execution?: ExecutionTarget;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [classification, setClassification] = useState<EvaluationInputClass | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const select = useCallback(
    (selected: File[]) => {
      setError(null);
      setProgress(null);
      setUploadingName(null);
      onCleared();

      if (selected.length === 0) {
        setFiles([]);
        setClassification(null);
        return;
      }
      if (selected.length > MAX_CAMERAS) {
        setFiles([]);
        setClassification(null);
        setError(`Select at most ${MAX_CAMERAS} synchronized camera videos.`);
        return;
      }

      const oversized = selected.find((file) => file.size > MAX_UPLOAD_BYTES);
      if (oversized) {
        setFiles([]);
        setClassification(null);
        setError(
          `${oversized.name} is ${formatBytes(oversized.size)}. The upload limit for each video is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
        );
        return;
      }

      const classifications = selected.map((file) => classifyEvaluationInput(file, model));
      const unsupportedIndex = classifications.findIndex((entry) => entry.kind !== "video-only");
      if (unsupportedIndex >= 0) {
        const rejected = selected[unsupportedIndex]!;
        setFiles([]);
        setClassification(null);
        setError(
          `${rejected.name} is not a supported video. Choose MP4, MOV, WebM or MKV recordings only; bundles and manifests belong to the separate research workflow.`,
        );
        return;
      }

      setFiles(selected);
      setClassification(classifications[0]!);
    },
    [model, onCleared],
  );

  const prepare = useCallback(
    (artifacts: UploadedArtifact[]) => {
      if (!classification) return;
      onPrepared({
        artifacts,
        classification,
        cameraProfile: "uploaded-video",
        files: files.map((file) => ({ name: file.name, bytes: file.size })),
        sourceFiles: files,
      });
    },
    [classification, files, onPrepared],
  );

  const useWithoutUpload = useCallback(() => prepare([]), [prepare]);

  const upload = useCallback(async () => {
    if (files.length === 0 || !classification) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setUploading(true);

    try {
      const artifacts: UploadedArtifact[] = [];
      for (const file of files) {
        setUploadingName(file.name);
        artifacts.push(
          await uploadEvaluationInput(gateway, file, {
            purpose: "video",
            signal: controller.signal,
            onProgress: setProgress,
          }),
        );
      }
      prepare(artifacts);
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
      setUploadingName(null);
      setUploading(false);
    }
  }, [classification, files, gateway, prepare]);

  const clear = () => {
    abortRef.current?.abort();
    setFiles([]);
    setClassification(null);
    setProgress(null);
    setUploadingName(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    onCleared();
  };

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <section {...stylex.props(s.section4)} data-testid="evaluation-input-step">
      <div {...stylex.props(s.row)}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
          {...stylex.props(s.hidden)}
          onChange={(event) => select(Array.from(event.target.files ?? []))}
          data-testid="evaluation-file-input"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload aria-hidden="true" />
          {files.length > 0 ? "Choose different videos" : "Choose camera videos"}
        </Button>
        {files.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" disabled={uploading} onClick={clear}>
            <X aria-hidden="true" />
            Clear
          </Button>
        ) : (
          <p {...stylex.props(s.textSm, s.textMuted)}>
            Select one video, or up to seven synchronized camera recordings together.
          </p>
        )}
      </div>

      {files.length > 0 ? (
        <div {...stylex.props(s.stack2)}>
          <p {...stylex.props(s.textXs, s.leading5, s.textMuted)}>
            File order is preserved through upload and submission. You will map each file to its
            real camera position after the upload.
          </p>
          <ul {...stylex.props(s.borderBox)} data-testid="evaluation-file-list">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} {...stylex.props(s.flexGap3, s.dividedRow, s.px3py2, s.textSm)}>
                <FileVideo aria-hidden="true" {...stylex.props(s.icon, s.textMuted)} />
                <span {...stylex.props(s.w14, s.shrink0, s.textXs, s.uppercaseWide, s.textMuted)}>Input {index + 1}</span>
                <span {...stylex.props(s.min0, s.flex1, s.truncate)}>{file.name}</span>
                <span {...stylex.props(s.shrink0, s.tabular, s.textMuted)}>{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <RefusalNotice title="Video selection failed" reasons={[error]} /> : null}

      {progress && progress.phase !== "done" ? (
        <div {...stylex.props(s.stack2)} data-testid="evaluation-upload-progress">
          <div {...stylex.props(s.flexBetween4, s.textXs, s.textMuted)}>
            <span {...stylex.props(s.inlineGap2, s.min0)}>
              <Loader2 aria-hidden="true" {...stylex.props(s.iconSm, s.spinner)} />
              <span {...stylex.props(s.truncate)}>
                {progress.phase === "hashing"
                  ? "Checksumming"
                  : progress.phase === "reserving"
                    ? "Requesting storage"
                    : progress.phase === "completing"
                      ? "Verifying stored bytes"
                      : "Uploading"}
                {uploadingName ? ` ${uploadingName}` : ""}
              </span>
            </span>
            <span {...stylex.props(s.shrink0, s.tabular)}>{formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)}</span>
          </div>
          <div {...stylex.props(s.progressTrack)}><div
            {...stylex.props(s.progressFill)}
            style={{
              width: `${progress.bytesTotal > 0 ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100) : 0}%`,
            }}
          /></div>
        </div>
      ) : null}

      {prepared ? (
        <p {...stylex.props(s.inlineGap2, s.textSm, s.textFg)} data-testid="evaluation-input-ready">
          <CheckCircle2 aria-hidden="true" {...stylex.props(s.iconPlain, s.textPrimary)} />
          {prepared.artifacts.length === 0
            ? `${prepared.files.length} video${prepared.files.length === 1 ? "" : "s"} ready for local execution — nothing was uploaded.`
            : `${prepared.artifacts.length} video${prepared.artifacts.length === 1 ? "" : "s"} stored and verified${
                prepared.artifacts.some((artifact) => artifact.deduplicated)
                  ? " (already held by this workspace)"
                  : ""
              }.`}
        </p>
      ) : (
        <Button
          type="button"
          disabled={disabled || uploading || files.length === 0 || classification === null}
          onClick={execution === "local" ? useWithoutUpload : () => void upload()}
          data-testid="evaluation-upload-button"
        >
          {uploading ? <Loader2 aria-hidden="true" {...stylex.props(s.spinner)} /> : null}
          {execution === "local"
            ? `Use ${files.length === 1 ? "this video" : `${files.length} videos`}`
            : `Upload ${files.length === 1 ? "video" : `${files.length} videos`}`}
          {totalBytes > 0 ? ` (${formatBytes(totalBytes)})` : ""}
        </Button>
      )}
    </section>
  );
}
