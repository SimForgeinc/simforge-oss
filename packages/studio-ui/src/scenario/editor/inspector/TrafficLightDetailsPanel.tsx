"use client";

import { useRef } from "react";
import { RotateCcw, Signal, Trash2 } from "lucide-react";

import { ReferenceLightEditor } from "../signals/ReferenceLightEditor";
import { EditorDetailsPanel } from "./EditorDetailsPanel";

import type {
  ReferenceCyclePhase,
  ReferenceCycleTiming,
} from "../../../lib/scenario/signals";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./TrafficLightDetailsPanel.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

export type TrafficLightCycleSnapshot = {
  readonly timing: ReferenceCycleTiming;
  readonly phaseOrder: readonly ReferenceCyclePhase[];
};

export type TrafficLightAuthoring = {
  readonly junctionId: string;
  readonly headId: string;
  readonly label: string;
  readonly timing: ReferenceCycleTiming;
  readonly phaseOrder: readonly ReferenceCyclePhase[];
  readonly generated: boolean;
  readonly crossingStageCount: number;
  readonly hasPlan: boolean;
  readonly warning?: string | null;
  readonly onTimingChange: (next: Partial<ReferenceCycleTiming>) => void;
  readonly onPhaseOrderChange: (next: readonly ReferenceCyclePhase[]) => void;
  readonly onReset: (snapshot: TrafficLightCycleSnapshot) => void;
  readonly onRemoveControl?: () => void;
};

export function TrafficLightDetailsPanel({
  authoring,
  onClose,
}: {
  authoring: TrafficLightAuthoring;
  onClose: () => void;
}) {
  const openingSnapshot = useRef<TrafficLightCycleSnapshot>({
    timing: { ...authoring.timing },
    phaseOrder: [...authoring.phaseOrder],
  });

  return (
    <EditorDetailsPanel
      ariaLabel={`Traffic light ${authoring.headId} details`}
      onClose={onClose}
      onDelete={authoring.onRemoveControl}
      preview={(
        <div {...stylex.props(styles.flexColCenter)}>
          <Signal aria-hidden="true" className={stylex.props(styles.size9Text).className} />
          <span {...stylex.props(styles.caps)}>
            Junction {authoring.junctionId}
          </span>
          <strong {...stylex.props(styles.xsWhiteMedium)}>
            Traffic light {authoring.headId}
          </strong>
        </div>
      )}
      testId="scenario-traffic-light-details-panel"
    >
      <p {...stylex.props(styles.relaxed)}>
        Set this light&rsquo;s cycle. Every other light in junction {authoring.junctionId}
        is aligned automatically from the map&rsquo;s controller stages.
      </p>
      {authoring.warning ? (
        <p {...stylex.props(styles.borderedRelaxed)} role="alert">
          {authoring.warning} Saving a timing replaces it with a binding to the current map.
        </p>
      ) : null}
      <ReferenceLightEditor
        timing={authoring.timing}
        phaseOrder={authoring.phaseOrder}
        generated={authoring.generated}
        crossingStageCount={authoring.crossingStageCount}
        label={authoring.label}
        headerAction={authoring.onRemoveControl ? (
          <button
            aria-label={`Remove control from traffic light ${authoring.headId}`}
            className={stylex.props(styles.gridCenteredTight, motionStyles.editorMotion).className}
            data-testid="traffic-light-remove-control"
            onClick={authoring.onRemoveControl}
            title="Remove control"
            type="button"
          >
            <Trash2 aria-hidden="true" className={stylex.props(styles.size35).className} />
          </button>
        ) : null}
        onTimingChange={authoring.onTimingChange}
        onPhaseOrderChange={authoring.onPhaseOrderChange}
      />
      {authoring.hasPlan ? (
        <button
          className={stylex.props(styles.flexCenterMid, motionStyles.editorMotion).className}
          data-testid="traffic-light-details-reset"
          onClick={() => authoring.onReset(openingSnapshot.current)}
          type="button"
        >
          <RotateCcw aria-hidden="true" className={stylex.props(styles.size35).className} />
          Reset changes
        </button>
      ) : null}
    </EditorDetailsPanel>
  );
}
