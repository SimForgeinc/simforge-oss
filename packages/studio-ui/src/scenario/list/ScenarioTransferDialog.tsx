"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useMemo, useState } from "react";
import type {
  ScenarioTransferOptionsDto,
  TransferDocumentRequest,
} from "@simforge-oss/studio-host";
import type { ScenarioDocumentSummaryDto } from "../../lib/scenario/contracts";
import { useStudioHost } from "../../host";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import { Button } from "../../components/ui/button";
import { CopyableErrorMessage } from "./CopyableErrorMessage";
import { styles } from "./ScenarioTransferDialog.stylex";

export function ScenarioTransferDialog({
  open,
  document,
  busy,
  onClose,
  onTransfer,
}: {
  open: boolean;
  document: ScenarioDocumentSummaryDto | null;
  busy: boolean;
  onClose: () => void;
  onTransfer: (input: TransferDocumentRequest) => Promise<boolean>;
}) {
  const studioHost = useStudioHost();
  const titleId = useId();
  const [options, setOptions] = useState<ScenarioTransferOptionsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetMapVersionId, setTargetMapVersionId] = useState("");
  const [siteId, setSiteId] = useState("");

  useEffect(() => {
    if (!open || !document) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setOptions(null);
    setTargetMapVersionId("");
    setSiteId("");
    void studioHost.projects.getDocumentTransferOptions(document.id).then(
      (next) => {
        if (!cancelled) setOptions(next);
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      },
    ).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [document, open, studioHost]);

  const selectedMap = useMemo(
    () => options?.maps.find((map) => map.mapVersionId === targetMapVersionId) ?? null,
    [options, targetMapVersionId],
  );
  if (!open || !document) return null;

  const blocked = busy || loading;
  const canTransfer = Boolean(targetMapVersionId && siteId) && !blocked;
  const close = () => {
    if (!blocked) onClose();
  };

  return (
    <div {...stylex.props(styles.overlay)}>
      <button
        type="button"
        aria-label="Close transfer dialog"
        {...stylex.props(styles.backdrop)}
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...stylex.props(styles.dialog)}
      >
        <h2 id={titleId} {...stylex.props(styles.title)}>Transfer to another map</h2>
        <p {...stylex.props(styles.intro)}>
          Lift this scenario into a portable form, then create a variation at a compatible site.
        </p>

        {loading ? <CloudActivityIndicator label="Finding compatible map sites..." /> : null}
        {error ? <CopyableErrorMessage message={error} {...stylex.props(styles.error)} /> : null}

        {options && !options.lift.ok ? (
          <div role="alert" {...stylex.props(styles.issuePanel)}>
            <strong>This scenario cannot be transferred yet.</strong>
            <ul {...stylex.props(styles.issueList)}>
              {options.lift.issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.path ?? index}`}>
                  <span {...stylex.props(styles.issueCode)}>{issue.code}</span>
                  {issue.path ? ` @${issue.path}` : ""}: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {options?.lift.ok ? (
          <>
            <label htmlFor={`${titleId}-map`} {...stylex.props(styles.label)}>Target map</label>
            <select
              id={`${titleId}-map`}
              value={targetMapVersionId}
              disabled={blocked}
              {...stylex.props(styles.select)}
              onChange={(event) => {
                setTargetMapVersionId(event.target.value);
                setSiteId("");
              }}
            >
              <option value="">Choose a map</option>
              {options.maps.map((map) => (
                <option key={map.mapVersionId} value={map.mapVersionId} disabled={map.siteIds.length === 0}>
                  {map.label}{map.siteIds.length === 0 ? " — no compatible sites" : ` — ${map.siteIds.length} sites`}
                </option>
              ))}
            </select>
            <label htmlFor={`${titleId}-site`} {...stylex.props(styles.label)}>Target site</label>
            <select
              id={`${titleId}-site`}
              value={siteId}
              disabled={blocked || !selectedMap}
              {...stylex.props(styles.select)}
              onChange={(event) => setSiteId(event.target.value)}
            >
              <option value="">Choose a site</option>
              {selectedMap?.siteIds.map((candidateSiteId) => (
                <option key={candidateSiteId} value={candidateSiteId}>{candidateSiteId}</option>
              ))}
            </select>
          </>
        ) : null}

        <div {...stylex.props(styles.actions)}>
          <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canTransfer}
            onClick={() => {
              if (!canTransfer) return;
              setError(null);
              void onTransfer({ targetMapVersionId, siteId }).then((transferred) => {
                if (transferred) onClose();
              });
            }}
          >
            {busy ? <CloudActivityIndicator label="Creating variation..." /> : "Create variation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
