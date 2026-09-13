"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Input } from "../../../components/ui/input";
import {
  actionsForActor,
  interactionForAction,
  type EditorDocument,
} from "@simforge-oss/editor";
import { snapToTimeGrid } from "../../../lib/scenario/timeline";
import type { Interaction } from "@simforge-oss/scenario";
import { CanonicalInteractionComposer } from "./CanonicalInteractionComposer";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ActionPalette.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

type Role = EditorDocument["data"]["roles"][number];

/** How long a directly-added `gap` or `exist` occupies before the author narrows it. */
const DIRECT_ADD_DURATION_S = 1;

/**
 * The catalog of actions the selected actor can perform, plus the time they land
 * at.
 *
 * The time field is shared by every button rather than per-action, because the
 * author's mental model is "at 3 seconds, do these three things" — asking for the
 * time again per action is what a form would do, not a timeline.
 *
 * The editor and playback share one clock. Actions are authored from t=0 through
 * the visible clip; there is no hidden pre-roll authoring range.
 */
export function ActionPalette({
  document,
  role,
  otherRole,
  interactions,
  time,
  onTimeChange,
}: {
  document: EditorDocument;
  role: Role | null;
  otherRole: Role | null;
  interactions: readonly Interaction[];
  time: number;
  onTimeChange: (time: number) => void;
}) {
  const timeId = useId();
  const clipSeconds = document.data.choreography?.clipSeconds ?? 20;
  const actions = useMemo(
    () =>
      role && !role.actor.static
        ? actionsForActor(role.actor.class, role.actor.catalogId)
        : [],
    [role],
  );
  const targetSpeedAction = actions.find(
    (action) =>
      action.verb === "speed" &&
      action.target.mode === "absolute",
  );
  const defaultTargetSpeed =
    typeof targetSpeedAction?.target.valueKph === "number"
      ? targetSpeedAction.target.valueKph
      : 0;
  const [targetSpeedKph, setTargetSpeedKph] = useState(defaultTargetSpeed);
  useEffect(() => setTargetSpeedKph(defaultTargetSpeed), [defaultTargetSpeed, role?.id]);

  const addDirect = (verb: "gap" | "exist", target: Interaction["target"]) => {
    if (!role) return;
    const continuous = verb === "gap";
    document.addInteraction({
      id: `${verb}_${role.id}_${interactions.length + 1}`,
      actor: role.id,
      label: verb === "gap" ? "Follow gap" : "Become absent",
      trigger: { kind: "at", t: snapToTimeGrid(Math.max(0, time)) },
      until: { kind: "at", t: snapToTimeGrid(Math.max(0, time) + DIRECT_ADD_DURATION_S) },
      verb,
      target,
      ...(continuous
        ? { dynamics: { shape: "linear", constraint: "time", value: 1 } }
        : {}),
    } as Interaction);
  };

  return (
    <div {...stylex.props(styles.tightWhiteRuleR)}>
      <label
        {...stylex.props(styles.blockCapsMicro)}
        htmlFor={timeId}
      >
        Add action at time
      </label>
      <div {...stylex.props(styles.flexGap2)}>
        <Input
          id={timeId}
          type="number"
          step={0.5}
          min={0}
          max={clipSeconds}
          value={time}
          onChange={(event) => onTimeChange(Number(event.target.value))}
          xstyle={styles.xsWhite}
          aria-describedby={`${timeId}-range`}
        />
        <span aria-hidden="true" {...stylex.props(styles.xsSelfCenter)}>
          seconds
        </span>
      </div>
      <p id={`${timeId}-range`} {...stylex.props(styles.micro)}>
        Choose a time from 0 to {clipSeconds} seconds.
      </p>
      {targetSpeedAction ? (
        <label {...stylex.props(styles.blockCapsMicro2)}>
          Target speed (kph)
          <Input
            xstyle={styles.xsWhite2}
            data-testid="action-palette-target-speed"
            step={1}
            type="number"
            value={targetSpeedKph}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value)) setTargetSpeedKph(Math.max(0, value));
            }}
          />
        </label>
      ) : null}
      {role ? (
        <div {...stylex.props(styles.mt3)}>
          <CanonicalInteractionComposer
            document={document}
            interactions={interactions}
            otherRole={otherRole}
            role={role}
            testIdPrefix="action-palette-canonical"
            time={time}
          />
        </div>
      ) : null}
      <div {...stylex.props(styles.scrollY)}>
        {actions.map((action) => (
          <PaletteButton
            key={action.id}
            testId={`action-palette-${action.id}`}
            onClick={() =>
              role &&
              document.addInteraction(
                interactionForAction(
                  action === targetSpeedAction
                    ? {
                        ...action,
                        target: { ...action.target, valueKph: targetSpeedKph },
                      }
                    : action,
                  role.id,
                  time,
                  interactions.length + 1,
                ),
              )
            }
          >
            {action.label}
          </PaletteButton>
        ))}
        {role && !role.actor.static && otherRole ? (
          <PaletteButton
            onClick={() =>
              addDirect("gap", { role: otherRole.id, value: 2, unit: "time" })
            }
          >
            Follow gap
          </PaletteButton>
        ) : null}
        {role ? (
          <PaletteButton onClick={() => addDirect("exist", { state: "absent" })}>
            Become absent
          </PaletteButton>
        ) : null}
        {!role ? (
          <p {...stylex.props(styles.xs)}>
            Select an actor to author behavior.
          </p>
        ) : role.actor.static ? (
          <p {...stylex.props(styles.xs)} data-testid="static-actor-action-message">
            Static actors stay fixed. Turn off Static / parked to add motion.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PaletteButton({
  children,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={stylex.props(styles.metaBordered, motionStyles.editorMotion).className}
    >
      {children}
    </button>
  );
}
