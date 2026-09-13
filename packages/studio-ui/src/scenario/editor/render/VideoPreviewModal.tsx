"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "../../../components/ui/button";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./VideoPreviewModal.stylex";

/**
 * Full-pane playback for one artifact — manifest #148.
 *
 * Takes a URL rather than an artifact id because the signature was minted per request by the route
 * that listed the artifact and must not be re-derived or stored. If the modal is open long enough for
 * a 1h signature to expire, the `<video>` element's own error state is the honest outcome; refreshing
 * the list re-signs.
 */
export function VideoPreviewModal({
  open,
  title,
  eyebrow,
  url,
  mediaType,
  onClose,
}: {
  open: boolean;
  title: string;
  eyebrow?: string | null;
  url: string | null;
  mediaType: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  const isVideo = mediaType.startsWith("video/");

  return (
    <div
      aria-label={title}
      aria-modal="true"
      {...stylex.props(styles.fixedFlexCenter)}
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div {...stylex.props(styles.flexColBordered)}>
        <header {...stylex.props(styles.flexCenterRuleB)}>
          <div {...stylex.props(styles.fillNarrowable)}>
            {eyebrow ? (
              <p {...stylex.props(styles.capsMicroMuted)}>
                {eyebrow}
              </p>
            ) : null}
            <h2 {...stylex.props(styles.smSemiboldTruncate)}>{title}</h2>
          </div>
          <Button aria-label="Close preview" onClick={onClose} size="icon" variant="ghost">
            <X aria-hidden="true" className={stylex.props(styles.size4).className} />
          </Button>
        </header>
        <div {...stylex.props(styles.relFillShrinkable)}>
          {!url ? (
            <p {...stylex.props(styles.gridCenteredCaps)}>
              This file has no playable URL.
            </p>
          ) : isVideo ? (
            <video autoPlay {...stylex.props(styles.fullContain)} controls loop muted playsInline src={url}>
              <track kind="captions" />
            </video>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- presigned URL; see RenderGalleryTile
            <img alt={title} {...stylex.props(styles.fullContain)} src={url} />
          )}
        </div>
      </div>
    </div>
  );
}
