"use client";

import { useState } from "react";
import * as stylex from "@stylexjs/stylex";

import { Button } from "../../../components/ui/button";
import { Dot } from "../../../components/ui/dot";
import { Spinner } from "../../../components/ui/spinner";
import { useStudioHost } from "../../../host";
import { hairline, surface, typography } from "../../../stylex/recipes.stylex";
import type { ScenarioSharedPlayback } from "../../scene/useScenarioSession";
import { CompareDialog } from "./CompareDialog";
import { versionsChanged } from "./versions-events";
import { diffChip, engineLabel, versionTitle } from "./versions-model";
import { styles } from "./versions.stylex";

/**
 * OWNS: the engine-change banner. The saved draft did not change, but its authoritative motion did
 * (a newer engine). The draft now shows the new motion; the author may keep the previous motion as
 * a version (it replays the stored result, nothing is re-simulated), compare the two, or move on.
 * Nothing happens until they choose; the banner comes back on the next open until they do.
 */
export function EngineChangeBanner({
  documentId,
  playback,
}: {
  documentId: string | null;
  playback: ScenarioSharedPlayback | undefined;
}) {
  const studioHost = useStudioHost();
  const pending = playback?.simulationEngineChange ?? null;
  const [busy, setBusy] = useState<"keep" | "accept" | null>(null);
  const [message, setMessage] = useState<{ tone: "positive" | "critical"; text: string } | null>(null);
  const [comparing, setComparing] = useState(false);
  if (message?.tone === "positive") {
    return (
      <section {...stylex.props(surface.raised, hairline.all, styles.banner)} data-testid="engine-change-banner" role="status">
        <Dot tone="positive" />
        <p {...stylex.props(typography.bodySm, styles.bannerBody)}>{message.text}</p>
      </section>
    );
  }
  if (!pending || pending.documentId !== documentId) return null;
  const { change } = pending;
  const chip = diffChip(change.motionDiff, true);
  const previous = engineLabel(change.previous.engineSemVer);
  const draft = { id: pending.documentId, draftVersion: pending.draftVersion };

  const keep = async () => {
    setBusy("keep");
    try {
      const result = await studioHost.projects.keepPreviousMotion(draft, {
        previousSimKey: change.previous.simKey,
        currentSimKey: change.current.simKey,
      });
      versionsChanged(pending.documentId);
      playback?.clearSimulationEngineChange?.();
      setMessage({ tone: "positive", text: `Saved ${versionTitle(result.revision)} with the ${previous} motion. The draft continues with ${engineLabel(change.current.engineSemVer)}.` });
    } catch (reason) {
      setMessage({ tone: "critical", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    setBusy("accept");
    try {
      await studioHost.projects.acceptDraftSimulation(draft, change.current.simKey);
      playback?.clearSimulationEngineChange?.();
    } catch (reason) {
      setMessage({ tone: "critical", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      {...stylex.props(surface.raised, hairline.all, styles.banner)}
      aria-labelledby="engine-change-banner-title"
      data-testid="engine-change-banner"
    >
      <Dot tone="warning" />
      <div {...stylex.props(styles.bannerText)}>
        <h2 {...stylex.props(typography.label, styles.bannerHeading)} id="engine-change-banner-title">
          Motion changed with {engineLabel(change.current.engineSemVer)}
        </h2>
        <p {...stylex.props(typography.bodySm, styles.bannerBody)}>
          {chip?.text ?? "The motion changed"} since {previous}. The draft now shows the new motion; keep the {previous} motion as a
          version to go on rendering it.
        </p>
        {message?.tone === "critical" ? (
          <p {...stylex.props(typography.bodySm, styles.bannerBody)} role="alert">{message.text}</p>
        ) : null}
      </div>
      <div {...stylex.props(styles.bannerActions)}>
        <Button data-testid="engine-change-keep" disabled={busy !== null} onClick={() => void keep()} size="sm" variant="accent">
          {busy === "keep" ? <Spinner size="sm" tone="onAccent" /> : null}
          Keep {change.previous.engineSemVer} motion as a version
        </Button>
        <Button data-testid="engine-change-compare" disabled={busy !== null} onClick={() => setComparing(true)} size="sm" variant="outline">
          Compare
        </Button>
        <Button data-testid="engine-change-accept" disabled={busy !== null} onClick={() => void accept()} size="sm" variant="ghost">
          Use new motion
        </Button>
      </div>
      <CompareDialog
        baseSimKey={comparing ? change.previous.simKey : null}
        candidateSimKey={comparing ? change.current.simKey : null}
        onClose={() => setComparing(false)}
        title={`${previous} vs ${engineLabel(change.current.engineSemVer)}`}
      />
    </section>
  );
}
