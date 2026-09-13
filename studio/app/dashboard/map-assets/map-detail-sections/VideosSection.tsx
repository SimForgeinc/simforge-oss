"use client";
import * as stylex from "@stylexjs/stylex";
import { styles, bridge } from "../map-assets.stylex";

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
        className={stylex.props(styles.s_566).className}
        aria-expanded={open}
      >
        <ChevronRight
          className={stylex.props(styles.chevron, open && styles.rotate90).className}
        />
        Videos
      </button>
      {open && (
        <ul className={stylex.props(styles.s_968).className}>
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
                    className={stylex.props(styles.s_545).className + " " + bridge.s_545}
                  >
                    <div className={stylex.props(styles.s_546).className}>
                      <video
                        // `#t=0.1` nudges the element to decode and paint an
                        // actual frame; the poster covers the gap until then.
                        src={`${previewUrl}#t=0.1`}
                        poster={posterUrl ?? undefined}
                        muted
                        playsInline
                        preload="metadata"
                        aria-label={label}
                        className={stylex.props(styles.s_547).className}
                      />
                      <div className={stylex.props(styles.s_548).className}>
                        <span className={stylex.props(styles.s_549).className + " " + bridge.s_549}>
                          <Play className={stylex.props(styles.s_550).className} />
                        </span>
                      </div>
                    </div>
                    <span className={stylex.props(styles.s_551).className}>
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
                  className={stylex.props(styles.s_552).className + " " + bridge.s_552}
                >
                  <div className={stylex.props(styles.s_553).className}>
                    <span className={stylex.props(styles.s_554).className + " " + bridge.s_554}>
                      <Play className={stylex.props(styles.s_555).className} />
                    </span>
                  </div>
                  <span className={stylex.props(styles.s_556).className}>
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
