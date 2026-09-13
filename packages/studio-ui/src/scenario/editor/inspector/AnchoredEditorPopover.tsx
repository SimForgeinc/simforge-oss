"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useAnchoredPopoverPosition } from "../../../lib/scenario/editor/anchored-popover";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./AnchoredEditorPopover.stylex";

const FORM_CARD_WIDTH = 420;
const FORM_CARD_MAX_HEIGHT = 560;

/** V1 floating-card chrome shared by v2 interaction and signal editors. */
export function AnchoredEditorPopover({
  anchorSelector,
  children,
  kind,
  kicker,
  title,
  onClose,
  id,
}: {
  anchorSelector: string;
  children: ReactNode;
  kind: "interaction" | "signal";
  kicker: string;
  title: string;
  onClose: () => void;
  id?: string;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const pointerRef = useRef<HTMLSpanElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  useEffect(() => setPortalRoot(window.document.body), []);

  const { anchorVisible, placement } = useAnchoredPopoverPosition({
    anchorSelector,
    panelRef,
    pointerRef,
    preferredWidth: FORM_CARD_WIDTH,
    maxPreferredHeight: FORM_CARD_MAX_HEIGHT,
    minimumUsefulHeight: 220,
    heightMode: "content",
    onClippedAnchor: "pin",
    placeWithinSelector: '[data-testid="scenario-editor-canvas-region"]',
    observe: { mutations: true, resize: true },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.isConnected) return;
      if (panelRef.current?.contains(target)) return;
      // Timeline anchors own switching/toggling. Portalled controls spawned by
      // the card are part of the card even though they are not descendants.
      if (
        target.closest(
          [
            "[data-timeline-interaction-id]",
            "[data-timeline-signal-cycle]",
            "[data-radix-popper-content-wrapper]",
            "[role='menu']",
            "[role='listbox']",
            "[role='dialog']",
          ].join(","),
        )
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  if (!portalRoot) return null;

  return createPortal(
    <aside
      ref={panelRef}
      aria-label={`${title} editor`}
      // The three `editor-actor-popover-enter-*` classes are global keyframe
      // rules in `styles.css`, applied by name and reduced-motion guarded
      // there — the documented exception for shared entrance motion. Each side
      // slides in from its own direction, so the class carries the animation.
      className={`${stylex.props(styles.popover).className} ${
        placement?.side === "right"
          ? "editor-actor-popover-enter-right"
          : placement?.side === "below"
            ? "editor-actor-popover-enter-below"
            : "editor-actor-popover-enter-above"
      }`}
      data-anchor-visible={String(anchorVisible)}
      data-detail-layout={`${kind}-popover`}
      data-detail-width="popover"
      data-testid={`scenario-${kind}-popover`}
      data-scenario-editor-popover={kind}
      id={id}
      role="dialog"
      style={
        placement
          ? {
              left: 0,
              maxHeight: placement.maxHeight,
              top: 0,
              transformOrigin:
                placement.side === "right"
                  ? `left ${placement.pointerTop}px`
                  : `${placement.pointerLeft}px ${placement.side === "above" ? "bottom" : "top"}`,
              translate: `${placement.left}px ${placement.top}px`,
              width: placement.width,
            }
          : {
              left: "50%",
              maxHeight: "min(560px, calc(100vh - 32px))",
              top: 16,
              transform: "translateX(-50%)",
              width: "min(420px, calc(100vw - 32px))",
            }
      }
    >
      <span
        ref={pointerRef}
        aria-hidden="true"
        {...stylex.props(styles.pointer, !anchorVisible && styles.pointerHidden)}
        data-testid="editor-popover-pointer"
      />
      <header {...stylex.props(styles.flexCenterTight)}>
        <div {...stylex.props(styles.fillNarrowable)}>
          <p {...stylex.props(styles.capsBoldLeadNone)}>
            {kicker}
          </p>
          <p {...stylex.props(styles.smWhiteSemibold)}>
            {title}
          </p>
        </div>
        <button
          aria-label={`Close ${kind} editor`}
          {...stylex.props(styles.flexCenterMid)}
          data-testid={`${kind}-popover-close`}
          type="button"
          onClick={onClose}
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
