"use client";

/**
 * Bulk operations for a multi-selection.
 *
 * The single-actor inspector deliberately stays closed while more than one
 * actor is selected — its numeric pose fields have no meaning for a set — so
 * this compact panel carries the set-level facts (count, unanchored count)
 * and the bulk verbs: duplicate, delete, clear.
 */

import { Copy, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "../../components/ui/button";
import {
  isRoadBoundMotorVehicle,
  type EditorController,
  type EditorState,
} from "@simforge-oss/editor";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./multi-selection.stylex";

export function MultiSelectionPanel({
  controller,
  state,
}: {
  controller: EditorController | null;
  state: EditorState;
}) {
  const count = state.selection.length;
  const unanchored = useMemo(() => {
    const selected = new Set(state.selection);
    return state.actors.filter(
      (actor) => selected.has(actor.id) && !actor.static && !actor.laneRef
        && isRoadBoundMotorVehicle(actor.catalogId),
    );
  }, [state.actors, state.selection]);

  if (count < 2) return null;
  return (
    <div
      {...stylex.props(styles.panel)}
      data-testid="multi-selection-panel"
    >
      <span {...stylex.props(styles.count)} data-testid="multi-selection-count">
        {count} selected
      </span>
      {unanchored.length > 0 ? (
        <Button
          className={stylex.props(styles.button).className}
          data-testid="multi-selection-resnap"
          onClick={() => controller?.resnapToLane(unanchored.map((actor) => actor.id))}
          size="sm"
          variant="outline"
        >
          Re-snap {unanchored.length} unanchored
        </Button>
      ) : null}
      <Button
        className={stylex.props(styles.button).className}
        data-testid="multi-selection-duplicate"
        onClick={() => controller?.duplicateSelection()}
        size="sm"
        variant="outline"
      >
        <Copy aria-hidden="true" />
        Duplicate
      </Button>
      <Button
        className={stylex.props(styles.button).className}
        data-testid="multi-selection-delete"
        onClick={() => controller?.deleteSelection()}
        size="sm"
        variant="outline"
      >
        <Trash2 aria-hidden="true" />
        Delete
      </Button>
      <Button
        aria-label="Clear selection"
        className={stylex.props(styles.clear).className}
        data-testid="multi-selection-clear"
        onClick={() => controller?.setSelection([])}
        size="sm"
        variant="ghost"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
