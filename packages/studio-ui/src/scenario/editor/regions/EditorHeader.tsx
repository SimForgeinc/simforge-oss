"use client";

import { ArrowLeft, BrainCircuit } from "lucide-react";
import {
  TopBarActionsPortal,
  TopBarTrailingPortal,
  useRouteHeader,
  useSetTopBarActionsAlignment,
} from "../../../components/TopBarSlot";
import type { CityViewer } from "@simforge-oss/viewer";
import { Button } from "../../../components/ui/button";
import type { ScenarioAuthoringQuality } from "../../../lib/scenario/contracts";
import type { EditorDocument } from "@simforge-oss/editor";
import {
  solutionForAuthoringIssue,
  type SimulationIssue,
} from "../simulation-issues";
import { ScenarioReadinessButton } from "../readiness";
import { EditorTutorialGuide } from "../tutorial/EditorTutorialGuide";
import { ViewportSettingsPanel } from "./slots/ViewportSettingsPanel";
import type { EditorExperience } from "../simple-timed-routes";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorHeader.stylex";
import { SimulationStatus } from "../SimulationStatus";
import type { ScenarioSharedPlayback } from "../../scene/useScenarioSession";
import { playerChrome } from "../player/player-mode.stylex";

const EXPECTED_MAP_BOUND_ISSUES = new Set([
  "non_portable_role",
  "pin_site_unresolved",
]);

/**
 * V1's focused editor toolbar over the V2 authoring runtime.
 *
 * Dataset-level actions remain in the scenario list. The reasoning-trace
 * action lives here because it directly adds an editor timeline lane.
 */
export function EditorHeader({
  document = null,
  getDebugInformation,
  onExit,
  viewer = null,
  quality,
  onQualityChange,
  simulationIssues = [],
  experience = null,
  onExperienceToggle,
  documentSaveStatus,
  playback,
  playerMode = false,
}: {
  document?: EditorDocument | null;
  getDebugInformation?: () => string;
  onExit?: () => void;
  viewer?: CityViewer | null;
  quality?: ScenarioAuthoringQuality;
  onQualityChange?: (quality: ScenarioAuthoringQuality) => void;
  simulationIssues?: readonly SimulationIssue[];
  experience?: EditorExperience | null;
  onExperienceToggle?: () => void;
  documentSaveStatus?: React.ReactNode;
  playback?: ScenarioSharedPlayback;
  /**
   * The simulation player owns the viewport. The authoring actions (tutorial,
   * readiness, reasoning trace, viewport settings) and the popovers they open
   * step aside; exit, save and verification status stay.
   */
  playerMode?: boolean;
}) {
  useRouteHeader({ title: "Editor" });
  useSetTopBarActionsAlignment("start");
  const sensorSubjectId = document?.data.roles.find(
    (role) => role.actor.sensors.length > 0,
  )?.id;
  const reasoningTraceEnabled = Boolean(
    sensorSubjectId && (
      document?.data.reasoningTrace.length > 0 ||
      document?.data.extensions?.["studio.presentation.reasoningTraceLane"] === true
    ),
  );
  const isFullyMapBound = Boolean(
    document?.data.roles?.length &&
    document.data.roles.every((role) => role.kind === "scene_absolute"),
  );
  const readinessIssues: readonly SimulationIssue[] = [
    ...(document?.validation?.issues ?? []).flatMap((issue, index) =>
      issue.severity === "info" ||
      (isFullyMapBound && EXPECTED_MAP_BOUND_ISSUES.has(issue.code))
        ? []
        : [{
            id: `authoring-${issue.code}-${index}`,
            severity: issue.severity,
            title: issue.severity === "error" ? "Scenario needs a change" : "Scenario suggestion",
            detail: `${issue.message} (${issue.path})`,
            solution: solutionForAuthoringIssue(issue.code, issue.path),
          }],
    ),
    ...simulationIssues,
  ];

  return (
    <>
      <TopBarActionsPortal>
        <div
          {...stylex.props(styles.flexCenterNarrowable)}
          data-testid="scenario-editor-toolbar"
          data-tour="toolbar"
        >
          {onExit ? (
            <Button
              aria-label="Exit editor"
              xstyle={styles.borderedGap15}
              onClick={onExit}
              size="md"
              type="button"
              variant="outline"
            >
              <ArrowLeft aria-hidden="true" className={stylex.props(styles.size35).className} />
              <span>Exit editor</span>
            </Button>
          ) : null}
          {documentSaveStatus}
          <SimulationStatus
            verification={playback?.simulationVerification}
            onRetry={playback?.retrySimulationVerification}
          />
        </div>
      </TopBarActionsPortal>
      <TopBarTrailingPortal>
        <div
          {...stylex.props(styles.flexCenterGap2, playerMode && playerChrome.hidden)}
          aria-hidden={playerMode || undefined}
          data-testid="scenario-editor-toolbar-trailing"
          inert={playerMode || undefined}
        >
          <EditorTutorialGuide experience={experience ?? "advanced"} />
          <ScenarioReadinessButton issues={readinessIssues} />
          {/* Weather and traffic moved to the left rail: they are things you add
              to the scenario, like actors, and they now share that panel's tile
              galleries. Reasoning traces stay advanced-only. */}
          {experience !== "simple" ? (
            <>
              <Button
                aria-label="Add reasoning trace"
                xstyle={styles.borderedGlassyGap2}
                data-testid="editor-add-reasoning-trace"
                disabled={!sensorSubjectId || reasoningTraceEnabled}
                onClick={() => document?.setPresentationExtension("studio.presentation.reasoningTraceLane", true)}
                size="md"
                title={!sensorSubjectId ? "Add a camera to a vehicle first" : reasoningTraceEnabled ? "Reasoning trace row already added" : "Add one reasoning trace row"}
                type="button"
                variant="accentOutline"
              >
                <BrainCircuit aria-hidden="true" className={stylex.props(styles.size4).className} />
                <span>Add reasoning trace</span>
              </Button>
            </>
          ) : null}
          <ViewportSettingsPanel
            experience={experience}
            getDebugInformation={getDebugInformation}
            onExperienceToggle={onExperienceToggle}
            onQualityChange={onQualityChange}
            placement="topbar"
            quality={quality}
            viewer={viewer}
          />
        </div>
      </TopBarTrailingPortal>
    </>
  );
}
