"use client";

import { Button } from "../../../components/ui/button";
import type { EditorController, EditorState } from "@simforge-oss/editor";
import { Check, Move3d, PenLine, Trash2, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorModeBanner.stylex";

/**
 * OWNS: the modal-mode strip.
 *
 * Direct manipulation in this editor is modal — grab, rotate and placement each
 * capture the pointer until committed or cancelled. The banner is the only thing
 * telling the author that the next click means something different from usual,
 * so it takes the brand surface and sits in flow rather than floating: pushing
 * the canvas down is the point, not a side effect.
 */
export function EditorModeBanner({
  state,
  controller,
}: {
  state: EditorState | null;
  controller: EditorController | null;
}) {
  if (!state) return null;
  // A flash is the controller's answer to something the author just did — a refused drag,
  // a cleared anchor — so it belongs on the strip in whatever mode provoked it. Showing it
  // only when idle meant the modes that flash most were the ones that said nothing, and a
  // gesture that quietly does nothing reads as a broken editor. The standing hint comes
  // back when the message expires.
  const message = state.message;
  if (state.mode === "idle" && !message) return null;
  const warning = message?.startsWith("Warning:") ?? false;

  return (
    <div
      {...stylex.props(styles.banner, warning ? styles.bannerWarning : styles.bannerMode)}
      data-banner-variant={warning ? "warning" : "mode"}
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`editor-pulse ${stylex.props(styles.pulseDot, warning ? styles.pulseDotWarning : styles.pulseDotMode).className}`}
      />
      {message ?? state.hint}
      {state.mode === "drawingRoute" ? (
        <div {...stylex.props(styles.flexCenterPushRight)}>
          <div {...stylex.props(styles.flexCenterPad05)}>
            <Button
              aria-pressed={state.customRouteTool === "add"}
              xstyle={state.customRouteTool === "add" ? styles.routeToolActive : styles.routeToolIdle}
              onClick={() => controller?.setCustomRouteTool("add")}
              size="sm"
              variant="ghost"
            >
              <PenLine className={stylex.props(styles.size35).className} /> Add points
            </Button>
            <Button
              aria-pressed={state.customRouteTool === "move"}
              xstyle={state.customRouteTool === "move" ? styles.routeToolActive : styles.routeToolIdle}
              onClick={() => controller?.setCustomRouteTool("move")}
              size="sm"
              variant="ghost"
            >
              <Move3d className={stylex.props(styles.size35).className} /> Move points
            </Button>
          </div>
          {state.customRouteTool === "add" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={state.customRoutePointCount < 2}
              onClick={() => controller?.finishCustomRouteAuthoring()}
              xstyle={styles.textPrimaryForegroundHoverBgPrimaryForeground10HoverTextPrimaryForeground}
            >
              <Check className={stylex.props(styles.size35).className} /> Finish
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={state.customRouteSelectedPointIndex === null}
              onClick={() => controller?.deleteSelectedCustomRoutePoint()}
              xstyle={styles.textPrimaryForegroundHoverBgPrimaryForeground10HoverTextPrimaryForeground}
            >
              <Trash2 className={stylex.props(styles.size35).className} /> Delete point
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => controller?.cancel()}
            xstyle={styles.textPrimaryForegroundHoverBgPrimaryForeground10HoverTextPrimaryForeground}
          >
            <X className={stylex.props(styles.size35).className} /> Close
          </Button>
        </div>
      ) : null}
      {state.mode !== "idle" && state.mode !== "drawingRoute" ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => controller?.cancel()}
          xstyle={styles.pushRight}
        >
          Esc · Cancel
        </Button>
      ) : null}
    </div>
  );
}
