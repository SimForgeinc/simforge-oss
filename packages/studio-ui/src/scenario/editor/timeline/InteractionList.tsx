"use client";

import { Radio, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { Interaction, Trigger } from "@simforge-oss/scenario";
import type { EditorDocument } from "@simforge-oss/editor";
import {
  choreographyWindow,
  resolveInteractionLayout,
} from "../../../lib/scenario/timeline";
import { InteractionTrack } from "./InteractionTrack";
import { InteractionTargetControls } from "./InteractionTargetControls";
import { TimelineRuler } from "./TimelineRuler";
import { TriggerControls } from "./TriggerControls";
import { triggerLabel } from "./trigger-defaults";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./InteractionList.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * The semantic timeline: one row per authored interaction, expandable into its
 * start and end triggers.
 *
 * Each row is a disclosure, so the button carries `aria-expanded` *and*
 * `aria-controls` pointing at the panel's `id` — v2 had the former without the
 * latter, which tells assistive tech that something expanded without saying what.
 *
 * Rows are ordered by authoring order, not by trigger time. A `when` trigger has
 * no time to sort by, and re-sorting rows as an author edits a threshold would
 * move the row out from under the pointer.
 *
 * ## The time axis (manifest 84)
 *
 * Each row carries a bar on a shared axis, so "at 3 s, do these three things"
 * is visible as three bars in a column rather than three numbers to compare by
 * eye. The words stay: `triggerLabel` remains on every row, because a `when`
 * trigger has no position worth reading off a rail and the bar can only say
 * "somewhere from here".
 *
 * Layout is resolved through the domain layer, which delegates to the model's
 * own timing analysis. The list does not compute times — if it did, the rail and
 * the validator could disagree, and that reads as a rendering bug.
 */
export function InteractionList({
  document,
  interactions,
  editingId,
  onEditingChange,
}: {
  document: EditorDocument;
  interactions: readonly Interaction[];
  editingId: string | null;
  onEditingChange: (id: string | null) => void;
}) {
  const { choreography } = document.data;
  const window = useMemo(() => choreographyWindow(choreography), [choreography]);
  // Keyed by id rather than index: a delete shifts every later index, and a bar drawn from a stale
  // index would attach to its neighbour's row — the kind of wrong that looks like a rendering glitch.
  const layout = useMemo(() => {
    const resolved = resolveInteractionLayout(document.data);
    return new Map(resolved.map((item) => [item.interaction.id, item]));
  }, [document.data]);

  const replaceTrigger = (
    interaction: Interaction,
    slot: "trigger" | "until",
    trigger: Trigger | undefined,
  ) => {
    const next = { ...interaction };
    if (slot === "trigger") next.trigger = trigger ?? { kind: "at", t: 0 };
    else if (trigger) next.until = trigger;
    else delete next.until;
    document.replaceInteraction(interaction.id, next);
  };

  return (
    <div {...stylex.props(styles.fillWhiteScrollY)} data-testid="semantic-timeline">
      <h2 {...stylex.props(styles.flexCenterCaps)}>
        <Radio aria-hidden="true" className={stylex.props(styles.mr2Size3).className} />
        Semantic timeline
        <span {...stylex.props(styles.pushRightNormalCase)}>
          {choreography.clipSeconds}s
        </span>
      </h2>
      {interactions.length > 0 ? <TimelineRuler choreography={choreography} /> : null}
      <div {...stylex.props(styles.stackXs)}>
        {interactions.map((interaction) => {
          const expanded = editingId === interaction.id;
          const panelId = `scenario-interaction-${interaction.id}`;
          const name = interaction.label ?? interaction.verb;
          const resolved = layout.get(interaction.id);
          return (
            <div key={interaction.id} data-testid={`interaction-row-${interaction.id}`}>
              <div
                {...stylex.props(styles.row, expanded ? styles.rowExpanded : styles.rowCollapsed)}
              >
                <button
                  type="button"
                  onClick={() => onEditingChange(expanded ? null : interaction.id)}
                  aria-controls={panelId}
                  aria-expanded={expanded}
                  data-testid={`interaction-expand-${interaction.id}`}
                  className={stylex.props(styles.flexCenterFill, motionStyles.editorMotion).className}
                >
                  <span {...stylex.props(styles.truncate)}>
                    {interaction.actor}
                  </span>
                  <span {...stylex.props(styles.mediumTruncate)}>{name}</span>
                  <span {...stylex.props(styles.monoPushRight)}>
                    {triggerLabel(interaction.trigger)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete action ${name}`}
                  className={stylex.props(styles.editorMotionMr2TextWhite30, motionStyles.editorMotion).className}
                  onClick={() => document.removeInteraction(interaction.id)}
                >
                  <Trash2 aria-hidden="true" className={stylex.props(styles.size3).className} />
                </button>
              </div>
              {resolved ? <InteractionTrack resolved={resolved} window={window} /> : null}
              <div
                {...stylex.props(expanded ? styles.inspector : styles.inspectorCollapsed)}
                id={panelId}
                data-testid={`interaction-inspector-${interaction.id}`}
              >
                {expanded ? (
                  <>
                    <TriggerControls
                      label="Starts"
                      value={interaction.trigger}
                      document={document}
                      actorId={interaction.actor}
                      interactionId={interaction.id}
                      interactions={interactions}
                      onChange={(value) =>
                        replaceTrigger(interaction, "trigger", value)
                      }
                    />
                    <TriggerControls
                      label="Ends"
                      value={interaction.until}
                      document={document}
                      actorId={interaction.actor}
                      interactionId={interaction.id}
                      interactions={interactions}
                      optional
                      onChange={(value) => replaceTrigger(interaction, "until", value)}
                    />
                    <div {...stylex.props(styles.ruleT)}>
                      <InteractionTargetControls
                        document={document}
                        interaction={interaction}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
        {interactions.length === 0 ? (
          <p {...stylex.props(styles.gridCenteredXs)}>
            Actions appear here as semantic, exportable OpenSCENARIO behavior.
          </p>
        ) : null}
      </div>
    </div>
  );
}
