"use client";

import { useStudioHost } from "../../../host";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import type {
  ScenarioJobProvenanceDto,
  ScenarioRenderJobDto,
} from "../../../lib/scenario/contracts";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioJobDetails.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * The provenance panel for a submitted render or 2D-interaction job.
 *
 * Every digest row here is load-bearing, not decoration: source revision,
 * execution package, compiler version, map version, XODR and asset-catalog
 * digests together are what makes a render reproducible after the fact. This is
 * the surface an OEM certification review reads. Do not thin it out.
 */
export function ScenarioJobDetails({
  job,
  onClose,
}: {
  job: ScenarioRenderJobDto;
  onClose: () => void;
}) {
  const studioHost = useStudioHost();
  const [provenance, setProvenance] =
    useState<ScenarioJobProvenanceDto | null>(null);

  useEffect(() => {
    let active = true;
    void studioHost.jobs.getRenderJobProvenance(job.id)
      .then((value) => {
        if (active) setProvenance(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [job.id, studioHost]);

  const percent = Math.round(job.progress * 100);
  const renderSpec = job.renderSpec;

  return (
    <aside
      {...stylex.props(styles.borderedScrollYTall)}
      data-testid="scenario-job-details"
    >
      <div {...stylex.props(styles.flexStart)}>
        <div>
          <p {...stylex.props(styles.capsXsMuted)}>
            {job.mode === "interaction_2d" ? "2D interaction" : "Full render"}
          </p>
          <h2 {...stylex.props(styles.semibold)}>{job.status}</h2>
        </div>
        <button
          type="button"
          aria-label="Close job details"
          className={stylex.props(styles.inlineFlexCenterMid, motionStyles.editorMotion).className}
          onClick={onClose}
        >
          <X aria-hidden="true" className={stylex.props(styles.size4).className} />
        </button>
      </div>
      <div
        aria-label={`${job.mode === "interaction_2d" ? "2D interaction" : "Render"} progress`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        {...stylex.props(styles.clip)}
        role="progressbar"
      >
        {/* A floor of 4% so a just-queued job still shows a sliver: a 0-width
            bar is indistinguishable from a missing bar. The announced value
            stays honest. */}
        <div
          {...stylex.props(styles.tall)}
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      </div>
      <Details title="OpenSCENARIO provenance">
        <Row label="Document" value={provenance?.documentId ?? "Loading…"} />
        <Row
          label="Revision"
          value={
            provenance
              ? `${provenance.revisionId} · #${provenance.revisionNumber}`
              : job.revisionId
          }
        />
        <Row label="XML profile" value="ASAM OpenSCENARIO XML 1.4.0" />
        <Row label="Validation" value={provenance?.validationStatus ?? "Pending"} />
        <Row label="Source digest" value={provenance?.sourceRevisionSha256 ?? "—"} />
        <Row
          label="Package digest"
          value={provenance?.executionPackageSha256 ?? "—"}
        />
        <Row label="Compiler" value={provenance?.compilerVersion ?? "—"} />
        <Row label="Map version" value={provenance?.mapVersionId ?? "—"} />
        <Row label="XODR digest" value={provenance?.xodrSha256 ?? "—"} />
        <Row label="Catalog digest" value={provenance?.assetCatalogSha256 ?? "—"} />
        <Row
          label="Coordinates"
          value={
            provenance
              ? `${provenance.coordinateSystemId} · ${provenance.coordinateSystemSha256}`
              : "—"
          }
        />
        <Row label="Traffic" value={String(provenance?.ambient.mode ?? "—")} />
        <Row
          label="Warnings"
          value={String(provenance?.capabilityWarnings.length ?? 0)}
        />
        <Row label="2D parity" value={job.parityResult ? "Available" : "Pending"} />
        <Row
          label="CARLA/local image"
          value={job.workerAttestation ? "Attested" : "Pending"}
        />
      </Details>
      <Details title="Configuration">
        <Row label="Execution" value="CARLA native physics" />
        <Row
          label="Sensors"
          value={
            job.mode === "interaction_2d"
              ? "None (sensor-free)"
              : String(renderSpec?.sources.length ?? 0)
          }
        />
        <Row
          label="Environment"
          value={
            renderSpec
              ? JSON.stringify(renderSpec.authoredEnvironment)
              : "Scenario execution only"
          }
        />
        <Row
          label="Outputs"
          value={
            renderSpec?.artifacts.join(", ") ?? "trace, manifest"
          }
        />
      </Details>
      <Details title="Artifacts" list={!provenance?.artifacts.length}>
        {provenance?.artifacts.length ? (
          provenance.artifacts.map((artifact) => (
            <div
              key={artifact.id}
              {...stylex.props(styles.flexXsBordered, styles.stackedMd)}
            >
              <button
                type="button"
                onClick={() => void studioHost.artifacts.openArtifact(artifact.id)}
                className={stylex.props(styles.fillNarrowableLeftText, motionStyles.editorMotion).className}
              >
                <span {...stylex.props(styles.accent)}>{artifact.kind}</span>
                <span {...stylex.props(styles.muted)}>
                  {artifact.sizeBytes.toLocaleString()} bytes
                </span>
              </button>
              <Button
                aria-label={`Download ${artifact.kind} artifact`}
                xstyle={styles.xsMutedPad0}
                size="sm"
                variant="link"
                onClick={() => void studioHost.artifacts.downloadArtifact(artifact.id)}
              >
                Download
              </Button>
            </div>
          ))
        ) : (
          <Row label="Status" value="No completed artifacts yet" />
        )}
      </Details>
      <Details title="Logs">
        {provenance?.events.length ? (
          provenance.events.map((event) => (
            <Row
              key={event.sequence}
              label={`#${event.sequence}`}
              value={`${event.type} · ${event.occurredAt}`}
            />
          ))
        ) : (
          <Row label="Status" value="Waiting for worker events" />
        )}
      </Details>
      {job.failureCode ? (
        <Details title="Error">
          <Row label="Code" value={job.failureCode} />
          <Row label="Details" value={JSON.stringify(job.failureDetail)} />
        </Details>
      ) : null}
    </aside>
  );
}

/**
 * `list` is false where the body is not label/value pairs — the artifact rows
 * are buttons, and a `<div>` of buttons inside a `<dl>` is not valid content.
 */
function Details({
  title,
  children,
  list = true,
}: {
  title: string;
  children: ReactNode;
  list?: boolean;
}) {
  const Body = list ? "dl" : "div";
  return (
    <section {...stylex.props(styles.ruleT)}>
      <h3 {...stylex.props(styles.capsXsMuted2)}>
        {title}
      </h3>
      <Body {...stylex.props(styles.mt3)}>{children}</Body>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div {...stylex.props(styles.flexXsGap4, styles.stackedMd)}>
      <dt {...stylex.props(styles.tightMuted)}>{label}</dt>
      <dd {...stylex.props(styles.narrowableBreakAll)}>{value}</dd>
    </div>
  );
}
