"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { ChevronRight, Download, Play } from "lucide-react";
import { s3UriToMapAssetProxyUrl } from "@/app/lib/media-utils";

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
        className={stylex.props(styles.s_465).className}
        aria-expanded={open}
      >
        <ChevronRight
          className={stylex.props(styles.chevron, open && styles.rotate90).className}
        />
        Artifacts ({visibleArtifacts.length})
      </button>
      {open && (
        <div className={stylex.props(styles.s_968).className}>
          <ul className={stylex.props(styles.s_879).className}>
            {visibleArtifacts.map((artifact, index) => {
              const proxyUrl = s3UriToMapAssetProxyUrl(artifact.uri, assetId);
              const filename = artifact.uri.split("/").pop() ?? "download";
              return (
                <li
                  key={`${artifact.uri}-${index}`}
                  className={stylex.props(styles.s_468).className}
                >
                  <div className={stylex.props(styles.s_761).className}>
                    <span className={stylex.props(styles.s_470).className}>
                      <span className={stylex.props(styles.s_517).className}>{artifact.artifact_type}</span>
                      {artifact.label ? ` — ${artifact.label}` : ""}
                    </span>
                    <span className={stylex.props(styles.s_472).className}>
                      {artifact.created_at && <span>{formatDate(artifact.created_at)}</span>}
                      {artifact.created_at && artifact.size_bytes != null && <span>·</span>}
                      {artifact.size_bytes != null && <span>{formatFileSize(artifact.size_bytes)}</span>}
                    </span>
                  </div>
                  <div className={stylex.props(styles.s_473).className}>
                    {artifact.artifact_type === "mp4" && proxyUrl && (
                      <button
                        type="button"
                        title="Play video"
                        aria-label={`Play ${artifact.label ?? artifact.artifact_type}`}
                        onClick={() => onViewArtifact?.({ proxyUrl, label: artifact.label })}
                        className={stylex.props(styles.s_478).className}
                      >
                        <Play className={stylex.props(styles.s_991).className} />
                      </button>
                    )}
                    {proxyUrl && (artifact.artifact_type === "mp4" || artifact.artifact_type === "image" || artifact.artifact_type === "thumbnail") ? (
                      <a
                        href={proxyUrl}
                        download={filename}
                        title={`Download ${filename}`}
                        aria-label={`Download ${filename}`}
                        className={stylex.props(styles.s_478).className}
                      >
                        <Download className={stylex.props(styles.s_991).className} />
                      </a>
                    ) : null}
                    {artifact.artifact_type === "search_index" ? (
                      <a
                        href={`/api/map-assets/${assetId}/search-index`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${filename} in a new tab`}
                        aria-label={`Open ${filename} in a new tab`}
                        className={stylex.props(styles.s_478).className}
                      >
                        <Download className={stylex.props(styles.s_991).className} />
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
