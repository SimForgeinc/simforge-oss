"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { ResizablePanel } from "../scenario/ResizablePanel";
import { layout } from "../stylex/tokens.stylex";
import { styles } from "./WorkspacePanes.stylex";

export type WorkspacePane = "list" | "detail" | "inspector";
export type WorkspacePanesProps = {
  rail: ReactNode; stage: ReactNode; inspector?: ReactNode;
  mode?: "auto" | "wide" | "narrow";
  activePane?: WorkspacePane; defaultActivePane?: WorkspacePane;
  onActivePaneChange?: (pane: WorkspacePane) => void;
  storageKey?: string; railLabel?: string;
  railVariant?: "solid" | "blur-gradient"; railCollapsed?: boolean;
  xstyle?: stylex.StyleXStyles;
};

/** Panes keep their identity across responsive mode changes, including retained canvases. */
export function WorkspacePanes({ rail, stage, inspector, mode = "auto", activePane, defaultActivePane = "list", onActivePaneChange, storageKey = "studio.workspace.rail-width", railLabel = "Resize list", railVariant = "solid", railCollapsed = false, xstyle }: WorkspacePanesProps) {
  const [wide, setWide] = useState(false);
  const [selected, setSelected] = useState(defaultActivePane);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const query = window.matchMedia(layout.workspaceBreakpoint.replace("@media ", ""));
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const narrow = mode === "narrow" || (mode === "auto" && !wide);
  const requested = activePane ?? selected;
  const current = requested === "inspector" && inspector == null ? "detail" : requested;
  useEffect(() => {
    const focused = document.activeElement;
    if (narrow && focused instanceof HTMLElement && root.current?.contains(focused) && focused.closest("[inert]")) {
      root.current.querySelector<HTMLButtonElement>(`button[data-pane="${current}"]`)?.focus();
    }
  }, [narrow, current]);
  return <div ref={root} {...stylex.props(styles.root, xstyle)} data-workspace-mode={narrow ? "narrow" : "wide"}>
    {narrow ? <nav aria-label="Workspace panes" {...stylex.props(styles.switcher)}>
      {(["list", "detail", ...(inspector != null ? ["inspector"] : [])] as WorkspacePane[]).map(pane => <button key={pane} type="button" data-pane={pane} aria-pressed={current === pane} {...stylex.props(styles.switchButton, current === pane && styles.selected)} onClick={() => { setSelected(pane); onActivePaneChange?.(pane); }}>{pane === "list" ? "List" : pane === "detail" ? "Detail" : "Inspector"}</button>)}
    </nav> : null}
    <div {...stylex.props(styles.panes)}>
      <ResizablePanel storageKey={storageKey} label={railLabel} variant={railVariant} collapsed={!narrow && railCollapsed} resizable={!narrow} xstyle={narrow && current !== "list" ? styles.hidden : undefined} inert={narrow && current !== "list"}>
        {rail}
      </ResizablePanel>
      <section aria-label="Detail" inert={narrow && current !== "detail"} {...stylex.props(styles.stage, narrow && current !== "detail" && styles.hidden)}>{stage}</section>
      {inspector != null ? <aside aria-label="Inspector" inert={narrow && current !== "inspector"} {...stylex.props(styles.inspector, narrow && styles.narrowInspector, narrow && current !== "inspector" && styles.hidden)}>{inspector}</aside> : null}
    </div>
  </div>;
}
