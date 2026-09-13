"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Square, X } from "lucide-react";

import { usePanelEdgeResize } from "../usePanelEdgeResize";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorDetailsPanel.stylex";

/** The width this panel had before it could be resized, and so the widest it may be. */
export const DETAILS_MAX_WIDTH = 192;
/** A quarter slimmer, which is where it opens until the author drags it. */
export const DETAILS_DEFAULT_WIDTH = Math.round(DETAILS_MAX_WIDTH * 0.75);

const EditorConfigurationBlockedContext = createContext(false);

export function EditorConfigurationBlockProvider({
  blocked,
  children,
}: {
  blocked: boolean;
  children: ReactNode;
}) {
  return (
    <EditorConfigurationBlockedContext.Provider value={blocked}>
      {children}
    </EditorConfigurationBlockedContext.Provider>
  );
}

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
  const configurationBlocked = useContext(EditorConfigurationBlockedContext);
  const { width, panelRef, separatorProps } = usePanelEdgeResize({
    storageKey: "uniscenario.editor.details-width",
    // 192 was this panel's only width, so it stays the ceiling. The default is a quarter slimmer:
    // the panel overlays the scene, and most of what it holds reads fine narrower.
    defaultWidth: DETAILS_DEFAULT_WIDTH,
    minWidth: 132,
    maxWidth: DETAILS_MAX_WIDTH,
    edge: "left",
    viewportReserve: 96,
    label: "Resize the details panel",
  });

  useEffect(() => setPortalRoot(window.document.body), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (configurationBlocked) return;
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
  }, [configurationBlocked, onClose, onDelete]);

  if (!portalRoot) return null;

  return createPortal(
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      aria-label={ariaLabel}
      className={`${stylex.props(styles.fixedFlexCol).className} editor-actor-details-enter`}
      data-placement="right-centered"
      data-size="compact"
      data-testid={testId}
      id={id}
      role="dialog"
      aria-disabled={configurationBlocked}
      style={{ height, maxHeight, width }}
    >
      {/*
        The panel is docked to the right edge, so its left edge is the only one the author can
        reach. Sits just inside the border, over the scroll area rather than beside it, because
        there is no room to spare at this width.
      */}
      <div
        {...separatorProps}
        {...stylex.props(styles.abs)}
        data-testid="editor-details-resize-handle"
      />
      <header {...stylex.props(styles.relTightRuleB)}>
        <div {...stylex.props(styles.preview, previewXstyle ?? styles.previewDefault)}>
          {preview}
        </div>
        {headerFooter}
        <button
          aria-label={closeLabel}
          {...stylex.props(styles.absGridCentered)}
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
      {configurationBlocked ? (
        <div
          {...stylex.props(styles.absGridCentered2)}
          data-testid="editor-details-simulation-blocker"
          role="status"
        >
          <div {...stylex.props(styles.flexColCenter)}>
            <Square aria-hidden="true" className={stylex.props(styles.size5FillText).className} />
            <strong {...stylex.props(styles.xsWhiteSnug)}>
              Cancel simulation first to configure
            </strong>
            <span {...stylex.props(styles.textTextWhite55)}>Press Esc to cancel simulation.</span>
          </div>
        </div>
      ) : null}
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
