"use client";

import {
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorDetailsPanel.stylex";
import { focus } from "../../../stylex/recipes.stylex";
import { useEditorPlayerMode } from "../player/player-mode";
import { playerChrome } from "../player/player-mode.stylex";

/** Shared right-side details surface for every selectable editor entity. */
export function EditorDetailsPanel({
  ariaLabel,
  children,
  closeLabel = "Close details",
  closeTestId = "editor-details-close",
  headerFooter,
  height,
  id,
  maxHeight = "min(460px, calc(100vh - 128px))",
  onClose,
  onDelete,
  preview,
  previewXstyle,
  testId,
}: {
  ariaLabel: string;
  children: ReactNode;
  closeLabel?: string;
  closeTestId?: string;
  headerFooter?: ReactNode;
  /** Optional fixed panel height. Content scrolls inside this frame. */
  height?: string;
  id?: string;
  maxHeight?: string;
  onClose: () => void;
  /** Delete the entity represented by this panel when Delete or Backspace is pressed. */
  onDelete?: () => void;
  preview: ReactNode;
  /** Geometry for the preview frame. Defaults to the compact `h-24 px-10 py-3` plate. */
  previewXstyle?: stylex.StyleXStyles;
  testId: string;
}) {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  // While the simulation player owns the viewport the panel steps aside rather
  // than unmounting, so it comes back with its scroll and open sections intact.
  const hiddenByPlayer = useEditorPlayerMode();

  useEffect(() => setPortalRoot(
    window.document.querySelector<HTMLElement>("[data-editor-stage]") ?? window.document.body,
  ), []);

  useEffect(() => {
    // A panel nobody can see answers no keys: Escape belongs to the player, and
    // Delete must never remove the actor behind a hidden panel.
    if (hiddenByPlayer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (
        !onDelete ||
        (event.key !== "Delete" && event.key !== "Backspace") ||
        isTextEditingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onDelete();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [hiddenByPlayer, onClose, onDelete]);

  if (!portalRoot) return null;
  const panelStyles = stylex.props(
    styles.fixedFlexCol,
    styles.frame(height ?? "auto", maxHeight),
    hiddenByPlayer && playerChrome.hidden,
  );

  return createPortal(
    <aside
      aria-label={ariaLabel}
      {...panelStyles}
      className={`${panelStyles.className} editor-actor-details-enter`}
      data-placement="right-centered"
      data-size="compact"
      data-testid={testId}
      id={id}
      role="dialog"
      aria-hidden={hiddenByPlayer || undefined}
      data-player-hidden={hiddenByPlayer ? "" : undefined}
      inert={hiddenByPlayer || undefined}
    >
      <header {...stylex.props(styles.relTightRuleB)}>
        <div {...stylex.props(styles.preview, previewXstyle ?? styles.previewDefault)}>
          {preview}
        </div>
        {headerFooter}
        <button
          aria-label={closeLabel}
          {...stylex.props([focus.ring, styles.absGridCentered])}
          data-testid={closeTestId}
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" className={stylex.props(styles.size35).className} />
        </button>
      </header>

      <div {...stylex.props(styles.fillScrollYShrinkable)}>
        {children}
      </div>
    </aside>,
    portalRoot,
  );
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target instanceof HTMLElement && target.isContentEditable ||
    Boolean(target.closest('[contenteditable]:not([contenteditable="false"])'))
  );
}
