"use client";

import type { DisplayArtifact, PresignedArtifact } from "@simforge-oss/studio-host";
import { useState } from "react";
import { Download, FileText, Film, Image as ImageIcon, Play, ShieldAlert } from "lucide-react";
import { CloudActivityIndicator } from "../../../components/CloudLoadingSurface";
import { Button } from "../../../components/ui/button";
import {
  artifactAvailability,
  formatBytes,
  groupArtifacts,
  isImage,
  shortDigest,
} from "./render-view-model";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderArtifactList.stylex";

/**
 * Artifact rows with previews and downloads — manifest #148.
 *
 * Serves two payload shapes. `[jobId]/downloads` arrives already signed; `artifact-index` and
 * `[jobId]/detail` arrive as metadata only, because those routes deliberately never presign. `signed`
 * tells the row which it has, and an unsigned-but-available row gets its URL minted on click through
 * `resolve` rather than up front — which is what keeps browsing a workspace from minting a 3600-second
 * credential per file nobody opened.
 *
 * Every row goes through `artifactAvailability`, which leads on `artifactState`. A `pending` artifact
 * has no complete object and a `quarantined` one failed its checksum, so neither gets a link: they get
 * an explicit state, because a download button that 404s or serves an unverified file is worse than a
 * sentence saying why there is no button.
 */
export function RenderArtifactList({
  artifacts,
  signed = true,
  emptyMessage = "This render has produced no files yet.",
  onPreview,
  resolve,
}: {
  artifacts: readonly DisplayArtifact[];
  /** True when this payload came from `downloads`. False for `artifact-index` / `detail`. */
  signed?: boolean;
  emptyMessage?: string;
  onPreview?: (artifact: PresignedArtifact) => void;
  /** Mint a URL for one unsigned row. Required when `signed` is false. */
  resolve?: (artifact: DisplayArtifact) => Promise<PresignedArtifact | null>;
}) {
  if (artifacts.length === 0) {
    return <p {...stylex.props(styles.xsMutedCenterText)}>{emptyMessage}</p>;
  }

  return (
    <div {...stylex.props(styles.flexColGap4)}>
      {groupArtifacts(artifacts).map((group) => (
        <section {...stylex.props(styles.flexColGap1)} key={group.title}>
          <h4 {...stylex.props(styles.capsMicroMuted)}>
            {group.title} · {group.items.length}
          </h4>
          <ul {...stylex.props(styles.borderedDivided)}>
            {group.items.map((artifact, index) => (
              <ArtifactRow
                artifact={artifact}
                key={artifact.id}
                onPreview={onPreview}
                resolve={resolve}
                signed={signed}
                xstyle={index > 0 ? styles.rowDivided : null}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ArtifactRow({
  artifact,
  signed,
  onPreview,
  resolve,
  xstyle,
}: {
  artifact: DisplayArtifact;
  signed: boolean;
  onPreview?: (artifact: PresignedArtifact) => void;
  resolve?: (artifact: DisplayArtifact) => Promise<PresignedArtifact | null>;
  /** The list's divider, which only StyleX on the row itself can draw. */
  xstyle?: stylex.StyleXStyles;
}) {
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [resolveFailed, setResolveFailed] = useState(false);

  const availability = artifactAvailability(artifact, { signed });
  const Icon = artifact.mediaType.startsWith("video/")
    ? Film
    : isImage(artifact)
      ? ImageIcon
      : artifact.artifactState === "quarantined"
        ? ShieldAlert
        : FileText;
  const openable = availability.kind === "ready" || availability.kind === "resolvable";
  const media = artifact.mediaType.startsWith("video/") || isImage(artifact);
  const displayName = artifact.identity?.actorId
    ? `${artifact.identity.actorId}/${artifact.identity.sensorId} · ${artifact.identity.modality} · ${artifact.identity.role}`
    : artifact.identity?.role ?? artifact.artifactKind;

  /** Signed rows act immediately; unsigned rows mint a URL first, then act on the result. */
  async function act(intent: "preview" | "download") {
    if (availability.kind === "ready") {
      if (intent === "preview") onPreview?.(artifact as PresignedArtifact);
      else window.open(availability.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (!resolve) return;
    setBusy(intent);
    setResolveFailed(false);
    try {
      const resolved = await resolve(artifact);
      const url = resolved && "url" in resolved ? resolved.url : null;
      // A row that was available at index time can have been cleaned up since. Say so on the row
      // rather than opening a dead tab.
      if (!resolved || !url) {
        setResolveFailed(true);
        return;
      }
      if (intent === "preview") onPreview?.(resolved);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setResolveFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li {...stylex.props(styles.flexCenterGap3, xstyle)}>
      <Icon
        aria-hidden="true"
        className={stylex.props(
          styles.artifactIcon,
          artifact.artifactState === "quarantined" ? styles.danger : styles.muted,
        ).className}
      />
      <div {...stylex.props(styles.fillNarrowable)}>
        <p {...stylex.props(styles.xsInkMedium)}>{displayName}</p>
        <p {...stylex.props(styles.microMutedTruncate)}>
          {formatBytes(artifact.byteLength)} · {artifact.mediaType}
          {artifact.relationship ? ` · ${artifact.relationship}` : ""}
          {" · "}
          <span title={artifact.sha256}>{shortDigest(artifact.sha256)}</span>
        </p>
      </div>
      {resolveFailed ? (
        <span {...stylex.props(styles.tightCapsMicro)}>
          No longer in storage
        </span>
      ) : openable && (availability.kind === "ready" || resolve) ? (
        <div {...stylex.props(styles.flexCenterTight)}>
          {media && onPreview ? (
            <Button
              aria-label={`Preview ${displayName}`}
              disabled={busy != null}
              onClick={() => void act("preview")}
              size="icon"
              variant="ghost"
            >
              {busy === "preview" ? (
                <CloudActivityIndicator iconXstyle={styles.size35} />
              ) : (
                <Play aria-hidden="true" className={stylex.props(styles.size35).className} />
              )}
            </Button>
          ) : null}
          <Button
            aria-label={`Download ${displayName}`}
            disabled={busy != null}
            onClick={() => void act("download")}
            size="icon"
            variant="ghost"
          >
            {busy === "download" ? (
              <CloudActivityIndicator iconXstyle={styles.size35} />
            ) : (
              <Download aria-hidden="true" className={stylex.props(styles.size35).className} />
            )}
          </Button>
        </div>
      ) : (
        <span
          {...stylex.props(
            styles.availabilityNote,
            availability.kind === "quarantined" ? styles.danger : styles.muted,
          )}
          data-artifact-state={artifact.artifactState}
        >
          {availability.message}
        </span>
      )}
    </li>
  );
}
