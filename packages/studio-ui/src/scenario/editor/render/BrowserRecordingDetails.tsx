"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { WorkspacePaneLoading } from "../../../components/WorkspacePaneLoading";
import { useVisiblePolling } from "../../../lib/use-visible-polling";
import {
  getBrowserRecordingClient as getBrowserRecording,
  getBrowserRecordingRevisionInputClient as getBrowserRecordingRevisionInput,
} from "../../../lib/scenario/recording-client";
import type { BrowserRecordingRevisionInput } from "../../../lib/scenario/recording-client";
import type { BrowserRecordingDetailDto } from "../../../lib/scenario/recording-contracts";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./BrowserRecordingDetails.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

const POLL_INTERVAL_MS = 3_000;


export function BrowserRecordingDetails({
  recordingId,
  onBack,
}: {
  recordingId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<BrowserRecordingDetailDto | null>(null);
  const [revisionContent, setRevisionContent] = useState<BrowserRecordingRevisionInput["content"] | null>(null);
  const [selectedCameraKey, setSelectedCameraKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getBrowserRecording(recordingId, signal);
      const revision = await getBrowserRecordingRevisionInput(next.revisionId, signal)
        .catch(() => null);
      if (!signal?.aborted) {
        setDetail(next);
        setRevisionContent(revision?.content ?? null);
        setError(null);
      }
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [recordingId]);

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  useEffect(() => setSelectedCameraKey(null), [recordingId]);
  useVisiblePolling(() => load(), POLL_INTERVAL_MS, detail?.status === "running");
  const cameraLabels = useMemo(() => new Map(
    revisionContent?.roles.flatMap((role) => role.actor.sensors.map((sensor) => [
      `${role.id}\u0000${sensor.id}`,
      sensor.label,
    ] as const)) ?? [],
  ), [revisionContent]);
  const cameraVideos = useMemo(() => {
    if (!detail) return [];
    return detail.request.renderSpec.sources
      .filter((source) => source.modality === "rgb")
      .flatMap((source) => {
        const artifact = detail.artifacts.find((candidate) =>
          candidate.role === "sensor_video"
          && candidate.downloadUrl
          && candidate.sensor?.actorId === source.actorId
          && candidate.sensor.sensorId === source.sensorId
          && candidate.sensor.modality === "rgb");
        return artifact ? [{
          artifact,
          key: `${source.actorId}\u0000${source.sensorId}`,
          label: cameraLabels.get(`${source.actorId}\u0000${source.sensorId}`) ?? source.sensorId,
        }] : [];
      });
  }, [cameraLabels, detail]);
  const selectedCamera = cameraVideos.find((camera) => camera.key === selectedCameraKey)
    ?? cameraVideos[0];
  const primaryVideo = detail?.artifacts.find(
    (artifact) => artifact.role === "video" && artifact.downloadUrl,
  );
  const previewVideo = selectedCamera?.artifact ?? primaryVideo;
  const activeSensorVideos = detail?.artifacts.filter(
    (artifact) => artifact.role === "sensor_video"
      && artifact.sensor?.modality !== "rgb"
      && artifact.downloadUrl,
  ) ?? [];


  return (
    <div {...stylex.props(styles.fillScrollYShrinkable)}>
      <div {...stylex.props(styles.flexCenterGap2)}>
        <Button aria-label="Back to render runs" onClick={onBack} size="icon" type="button" variant="ghost">
          <ArrowLeft aria-hidden="true" className={stylex.props(styles.size4).className} />
        </Button>
        <div {...stylex.props(styles.fillNarrowable)}>
          <h3 {...stylex.props(styles.smSemibold)}>Three.js recording</h3>
          <p {...stylex.props(styles.monoMicroMuted)}>{recordingId}</p>
        </div>
        {detail ? <RecordingStatus status={detail.status} /> : null}
      </div>
      {error ? <p {...stylex.props(styles.xsDanger)} role="alert">{error}</p> : null}
      {!detail ? (
        <WorkspacePaneLoading
          xstyle={styles.minH72}
          hint="Reading the recording timeline and generated artifacts."
          message="Loading recording details…"
        />
      ) : (
        <>
          {previewVideo ? (
            <>
              <video
                aria-label={selectedCamera
                  ? `Browser recording camera ${selectedCamera.label}`
                  : "Browser recording primary camera"}
                {...stylex.props(styles.borderedWideVideo)}
                controls
                key={previewVideo.artifactId}
                playsInline
                preload="metadata"
                src={previewVideo.downloadUrl ?? undefined}
              />
              {cameraVideos.length > 0 ? (
                <section {...stylex.props(styles.mt3)} aria-labelledby="camera-views-heading">
                  <div {...stylex.props(styles.flexBetweenBaseline)}>
                    <h4 {...stylex.props(styles.capsXsSemibold)} id="camera-views-heading">
                      Camera views
                    </h4>
                    <span {...stylex.props(styles.monoMicroMuted2)}>
                      {cameraVideos.length} cameras
                    </span>
                  </div>
                  <div aria-label="Rendered camera views" {...stylex.props(styles.flexGap2ScrollX)} role="group">
                    {cameraVideos.map((camera) => (
                      <button
                        aria-pressed={camera.key === selectedCamera?.key}
                        className={stylex.props(
                          styles.tightXsBordered,
                          motionStyles.editorMotion,
                          camera.key === selectedCamera?.key && styles.cameraChipSelected,
                        ).className}
                        key={camera.key}
                        onClick={() => setSelectedCameraKey(camera.key)}
                        type="button"
                      >
                        {camera.label}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
          {activeSensorVideos.length > 0 ? (
            <section {...stylex.props(styles.mt4)} aria-labelledby="active-sensor-videos-heading">
              <div {...stylex.props(styles.flexBetweenBaseline)}>
                <h4 {...stylex.props(styles.capsXsSemibold)} id="active-sensor-videos-heading">
                  LiDAR and radar views
                </h4>
                <span {...stylex.props(styles.monoMicroMuted2)}>
                  {activeSensorVideos.length} videos
                </span>
              </div>
              <div {...stylex.props(styles.gridGap3)}>
                {activeSensorVideos.map((artifact) => (
                  <figure {...stylex.props(styles.borderedPad2)} key={artifact.artifactId}>
                    <video
                      aria-label={`${artifact.sensor?.modality ?? "Sensor"} visualization for ${artifact.sensor?.sensorId ?? "sensor"}`}
                      {...stylex.props(styles.wideVideo)}
                      controls
                      playsInline
                      preload="metadata"
                      src={artifact.downloadUrl ?? undefined}
                    />
                    <figcaption {...stylex.props(styles.monoMicroMuted3)}>
                      {artifact.sensor?.sensorId} · {artifact.sensor?.modality}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ) : null}
          <dl {...stylex.props(styles.gridXsCols2)}>
            <DetailValue label="Phase" value={formatPhase(detail.phase)} />
            <DetailValue label="Progress" value={`${Math.round(detail.progress * 100)}%`} />
            <DetailValue label="Created" value={formatTimestamp(detail.createdAt)} />
            <DetailValue label="Completed" value={detail.completedAt ? formatTimestamp(detail.completedAt) : "—"} />
            <DetailValue label="Revision" value={detail.revisionId} mono />
            <DetailValue label="Request digest" value={detail.requestPayloadSha256} mono />
          </dl>
          {detail.failureCode ? (
            <div {...stylex.props(styles.xsDangerBordered)} role="alert">
              <p {...stylex.props(styles.medium)}>{formatPhase(detail.failureCode)}</p>
              {detail.failureDetail ? <pre {...stylex.props(styles.micro)}>{JSON.stringify(detail.failureDetail, null, 2)}</pre> : null}
            </div>
          ) : null}
          <section {...stylex.props(styles.mt4)} aria-labelledby="browser-recording-files-heading">
            <h4 {...stylex.props(styles.capsXsSemibold)} id="browser-recording-files-heading">Files</h4>
            {detail.artifacts.length === 0 ? (
              <p {...stylex.props(styles.xsMuted)}>Files appear after encoding and checksum verification.</p>
            ) : (
              <ul {...stylex.props(styles.listMt2)}>
                {detail.artifacts.map((artifact, index) => (
                  <li {...stylex.props(styles.flexCenterXs, index > 0 && styles.rowStackedXs)} key={artifact.artifactId}>
                    <span {...stylex.props(styles.fillTruncateNarrowable)}>
                      {formatPhase(artifact.role)}
                      {artifact.sensor
                        ? ` · ${artifact.sensor.actorId}/${artifact.sensor.sensorId}/${artifact.sensor.modality}`
                        : ""}
                      {" · "}{formatBytes(artifact.sizeBytes)}
                    </span>
                    {artifact.downloadUrl ? (
                      <a aria-label={`Download ${artifact.role}${artifact.sensor ? ` ${artifact.sensor.sensorId} ${artifact.sensor.modality}` : ""}`} className={stylex.props(styles.gridCenteredBordered, motionStyles.editorMotion).className} download href={artifact.downloadUrl}>
                        <Download aria-hidden="true" className={stylex.props(styles.size35).className} />
                      </a>
                    ) : <span {...stylex.props(styles.microMuted)}>{artifact.state}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RecordingStatus({ status }: { status: BrowserRecordingDetailDto["status"] }) {
  return <span {...stylex.props(styles.capsMicroMuted)}>{status}</span>;
}

function DetailValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div {...stylex.props(styles.narrowable)}><dt {...stylex.props(styles.muted)}>{label}</dt><dd {...stylex.props(mono ? styles.detailValueMono : styles.detailValue)}>{value}</dd></div>;
}

function formatPhase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
