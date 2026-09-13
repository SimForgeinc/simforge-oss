"use client";

import { Route, Trash2, Workflow } from "lucide-react";
import type { Interaction, Trigger } from "@simforge-oss/scenario";

import type { EditorDocument } from "@simforge-oss/editor";
import { InteractionSemanticsControls } from "../timeline/InteractionSemanticsControls";
import { InteractionTargetControls } from "../timeline/InteractionTargetControls";
import { TriggerControls } from "../timeline/TriggerControls";
import { EditorDetailsPanel } from "./EditorDetailsPanel";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./InteractionActionPopover.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/** Full v2 action editor in the shared right-side details surface. */
export function InteractionActionPopover({
  document,
  interaction,
  onConfigureCustomRoute,
  onClose,
}: {
  document: EditorDocument;
  interaction: Interaction;
  onConfigureCustomRoute?: (interactionId: string) => void;
  onClose: () => void;
}) {
  const interactions = document.data.choreography.interactions;
  const name = interaction.label ?? interaction.verb;
  const deleteInteraction = () => {
    document.removeInteraction(interaction.id);
    onClose();
  };

  const replaceTrigger = (
    slot: "trigger" | "until",
    trigger: Trigger | undefined,
  ) => {
    const next = { ...interaction };
    if (slot === "trigger") next.trigger = trigger ?? { kind: "at", t: 0 };
    else if (trigger) next.until = trigger;
    else delete next.until;
    document.replaceInteraction(interaction.id, next);
  };

  const semanticTarget =
    (interaction.verb === "speed" && interaction.target.mode === "absolute") ||
    (interaction.verb === "changeLane" && interaction.target.mode === "relative");
  const customRouteTarget = interaction.verb === "route" && (
    interaction.target.mode === "customRoute" || interaction.target.mode === "customTimedRoute"
  )
    ? interaction.target
    : null;

  if (customRouteTarget) {
    return (
      <EditorDetailsPanel
        ariaLabel="Custom route details"
        id={`scenario-interaction-${interaction.id}`}
        onClose={onClose}
        onDelete={deleteInteraction}
        preview={(
          <div {...stylex.props(styles.flexColCenter)}>
            <Route aria-hidden="true" className={stylex.props(styles.size9Text).className} />
            <strong {...stylex.props(styles.xsWhiteMedium)}>
              {customRouteTarget.mode === "customTimedRoute" ? "Custom timed route" : "Custom route"}
            </strong>
          </div>
        )}
        testId="scenario-custom-route-panel"
      >
        <button
          className={stylex.props(styles.flexCenterMid, motionStyles.editorMotion).className}
          data-testid={`interaction-custom-route-configure-${interaction.id}`}
          onClick={() => {
            onConfigureCustomRoute?.(interaction.id);
            onClose();
          }}
          type="button"
        >
          Configure
        </button>
      </EditorDetailsPanel>
    );
  }

  return (
    <EditorDetailsPanel
      ariaLabel={`${name} interaction details`}
      id={`scenario-interaction-${interaction.id}`}
      onClose={onClose}
      onDelete={deleteInteraction}
      preview={(
        <div {...stylex.props(styles.flexColCenter)}>
          <Workflow aria-hidden="true" className={stylex.props(styles.size9Text).className} />
          <span {...stylex.props(styles.caps)}>
            Editing interaction
          </span>
          <strong {...stylex.props(styles.xsWhiteMedium2)}>{name}</strong>
        </div>
      )}
      testId="scenario-interaction-popover"
    >
      <div
        {...stylex.props(styles.stackXl)}
        data-actor-id={interaction.actor}
        data-interaction-id={interaction.id}
        data-testid={`interaction-overlay-editor-${interaction.id}`}
      >
        <p {...stylex.props(styles.capsBreakAll)}>
          {interaction.actor} · {interaction.verb}
        </p>
        <div {...stylex.props(styles.gridCols1Gap3)}>
          <TriggerControls
            label="Starts"
            value={interaction.trigger}
            document={document}
            actorId={interaction.actor}
            interactionId={interaction.id}
            interactions={interactions}
            onChange={(value) => replaceTrigger("trigger", value)}
          />
          <TriggerControls
            label="Ends"
            value={interaction.until}
            document={document}
            actorId={interaction.actor}
            interactionId={interaction.id}
            interactions={interactions}
            optional
            onChange={(value) => replaceTrigger("until", value)}
          />
          <InteractionSemanticsControls
            document={document}
            interaction={interaction}
          />
          {!semanticTarget ? (
            <div {...stylex.props(styles.ruleT)}>
              <InteractionTargetControls
                document={document}
                interaction={interaction}
              />
            </div>
          ) : null}
        </div>
        <button
          className={stylex.props(styles.flexCenterMid2, motionStyles.editorMotion).className}
          data-testid={`interaction-overlay-delete-${interaction.id}`}
          type="button"
          onClick={deleteInteraction}
        >
          <Trash2 aria-hidden="true" className={stylex.props(styles.size35).className} />
          Delete action
        </button>
      </div>
    </EditorDetailsPanel>
  );
}
