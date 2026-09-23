"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ArtifactsSection.stylex";

import { ChevronRight, Download, Play } from "lucide-react";
import { s3UriToMapAssetProxyUrl } from "@/app/lib/media-utils";
import { hairline, motionRecipe, textLayout, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Props for the ArtifactsSection component. */
type ArtifactsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  artifacts: { uri: string; artifact_type: string; label?: string; sha256?: string; size_bytes?: number | null; created_at?: string | null }[];
  assetId: string;
  onViewArtifact?: (info: { proxyUrl: string; label?: string }) => void;
};

/** Display downloadable artifact list with play/download controls and thumbnail preview. */
export function ArtifactsSection({
  open,
  onToggleOpen,
  artifacts,
  assetId,
  onViewArtifact,
}: ArtifactsSectionProps) {
  // `mp4_preview` is an auto-generated low-res downsample of a fly-by video,
  // managed by the map-flyby-preview Lambda and only surfaced on catalog cards.
  // Hide it here so the artifact list shows the real, user-managed assets.
  const visibleArtifacts = artifacts.filter((a) => a.artifact_type !== "mp4_preview");
  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        {...stylex.props([motionRecipe.colors, [typography.caps, styles.artifactsToggle]])}
        aria-expanded={open}
      >
        <ChevronRight
          {...stylex.props([motionRecipe.transform, styles.chevron], open && styles.rotate90)}
        />
        Artifacts ({visibleArtifacts.length})
      </button>
      {open && (
        <div {...stylex.props(styles.artifactsContent)}>
          <ul {...stylex.props(styles.artifactsList)}>
            {visibleArtifacts.map((artifact, index) => {
              const proxyUrl = s3UriToMapAssetProxyUrl(artifact.uri, assetId);
              const filename = artifact.uri.split("/").pop() ?? "download";
              return (
                <li
                  key={`${artifact.uri}-${index}`}
                  {...stylex.props([hairline.all, styles.artifactItem])}
                >
                  <div {...stylex.props(styles.artifactInfo)}>
                    <span {...stylex.props([textLayout.truncate, styles.artifactTitle])}>
                      <span {...stylex.props(styles.artifactType)}>{artifact.artifact_type}</span>
                      {artifact.label ? ` — ${artifact.label}` : ""}
                    </span>
                    <span {...stylex.props(styles.artifactMetadata)}>
                      {artifact.created_at && <span>{formatDate(artifact.created_at)}</span>}
                      {artifact.created_at && artifact.size_bytes != null && <span>·</span>}
                      {artifact.size_bytes != null && <span>{formatFileSize(artifact.size_bytes)}</span>}
                    </span>
                  </div>
                  <div {...stylex.props(styles.artifactActions)}>
                    {artifact.artifact_type === "mp4" && proxyUrl && (
                      <button
                        type="button"
                        title="Play video"
                        aria-label={`Play ${artifact.label ?? artifact.artifact_type}`}
                        onClick={() => onViewArtifact?.({ proxyUrl, label: artifact.label })}
                        {...stylex.props([motionRecipe.colors, styles.artifactAction])}
                      >
                        <Play {...stylex.props(styles.artifactActionIcon)} />
                      </button>
                    )}
                    {proxyUrl && (artifact.artifact_type === "mp4" || artifact.artifact_type === "image" || artifact.artifact_type === "thumbnail") ? (
                      <a
                        href={proxyUrl}
                        download={filename}
                        title={`Download ${filename}`}
                        aria-label={`Download ${filename}`}
                        {...stylex.props([motionRecipe.colors, styles.artifactAction])}
                      >
                        <Download {...stylex.props(styles.artifactActionIcon)} />
                      </a>
                    ) : null}
                    {artifact.artifact_type === "search_index" ? (
                      <a
                        href={`/api/map-assets/${assetId}/search-index`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${filename} in a new tab`}
                        aria-label={`Open ${filename} in a new tab`}
                        {...stylex.props([motionRecipe.colors, styles.artifactAction])}
                      >
                        <Download {...stylex.props(styles.artifactActionIcon)} />
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
