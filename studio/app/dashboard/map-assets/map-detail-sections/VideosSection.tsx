"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./VideosSection.stylex";

import { ChevronRight, Play } from "lucide-react";
import { s3UriToMapAssetProxyUrl } from "@/app/lib/media-utils";

/** A fly-by `mp4` artifact, optionally paired with its low-res preview clip. */
type FlybyArtifact = {
  uri: string;
  artifact_type: string;
  label?: string;
  /** S3 URI of the matching `mp4_preview` clip, when one exists. */
  previewUri?: string | null;
};

/** Props for the VideosSection component. */
type VideosSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  mp4Artifacts: FlybyArtifact[];
  assetId: string;
  /** S3 URI of the map thumbnail, used as the preview poster while it loads. */
  thumbnailUri?: string | null;
  onViewArtifact: (info: { proxyUrl: string; label?: string }) => void;
};

/** Display playable MP4 video artifacts for a map asset. */
export function VideosSection({
  open,
  onToggleOpen,
  mp4Artifacts,
  assetId,
  thumbnailUri,
  onViewArtifact,
}: VideosSectionProps) {
  const posterUrl = thumbnailUri ? s3UriToMapAssetProxyUrl(thumbnailUri, assetId) : null;

  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        {...stylex.props(styles.videosToggleButton)}
        aria-expanded={open}
      >
        <ChevronRight
          {...stylex.props(styles.chevron, open && styles.rotate90)}
        />
        Videos
      </button>
      {open && (
        <ul {...stylex.props(styles.videosList)}>
          {mp4Artifacts.map((artifact) => {
            const proxyUrl = s3UriToMapAssetProxyUrl(artifact.uri, assetId);
            if (!proxyUrl) return null;
            const label = artifact.label || "Fly-by video";
            const previewUrl = artifact.previewUri
              ? s3UriToMapAssetProxyUrl(artifact.previewUri, assetId)
              : null;

            // With a preview clip, show a larger 16:9 thumbnail of its first
            // frame (static — no autoplay) with a play overlay. Clicking always
            // opens the full-res mp4 in the media panel below the map.
            if (previewUrl) {
              return (
                <li key={artifact.uri}>
                  <button
                    type="button"
                    onClick={() => onViewArtifact({ proxyUrl, label: artifact.label })}
                    {...stylex.props(styles.previewVideoButton)}
                  >
                    <div {...stylex.props(styles.previewVideoFrame)}>
                      <video
                        // `#t=0.1` nudges the element to decode and paint an
                        // actual frame; the poster covers the gap until then.
                        src={`${previewUrl}#t=0.1`}
                        poster={posterUrl ?? undefined}
                        muted
                        playsInline
                        preload="metadata"
                        aria-label={label}
                        {...stylex.props(styles.previewVideo)}
                      />
                      <div {...stylex.props(styles.previewPlayOverlay)}>
                        <span {...stylex.props(styles.previewPlayButton)}>
                          <Play {...stylex.props(styles.previewPlayIcon)} />
                        </span>
                      </div>
                    </div>
                    <span {...stylex.props(styles.previewVideoLabel)}>
                      {label}
                    </span>
                  </button>
                </li>
              );
            }

            // No preview available — keep the compact play-icon row.
            return (
              <li key={artifact.uri}>
                <button
                  type="button"
                  onClick={() => onViewArtifact({ proxyUrl, label: artifact.label })}
                  {...stylex.props(styles.compactVideoButton)}
                >
                  <div {...stylex.props(styles.compactPlayContainer)}>
                    <span {...stylex.props(styles.compactPlayButton)}>
                      <Play {...stylex.props(styles.compactPlayIcon)} />
                    </span>
                  </div>
                  <span {...stylex.props(styles.compactVideoLabel)}>
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
