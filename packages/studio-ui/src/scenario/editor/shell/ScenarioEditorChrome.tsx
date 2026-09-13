import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../../lib/utils";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioEditorChrome.stylex";

export type ScenarioEditorStatusTone =
  | "neutral"
  | "saved"
  | "working"
  | "warning"
  | "error";

const STATUS_TONE_STYLES: Record<ScenarioEditorStatusTone, stylex.StyleXStyles> = {
  neutral: styles.statusNeutral,
  saved: styles.statusSaved,
  working: styles.statusWorking,
  warning: styles.statusWarning,
  error: styles.statusError,
};

/** Compact document chrome shared by the canvas and OpenSCENARIO workspaces. */
export function ScenarioEditorChromeHeader({
  title,
  subtitle,
  badge = "Scenario",
  status,
  statusTone = "neutral",
  leading,
  actions,
  className,
  ...headerProps
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  status?: ReactNode;
  statusTone?: ScenarioEditorStatusTone;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header
      {...headerProps}
      className={cn(stylex.props(styles.flexCenterRuleB).className, className)}
      data-editor-shell-region="header"
    >
      {leading ? <div {...stylex.props(styles.tight)}>{leading}</div> : null}
      <div {...stylex.props(styles.fillNarrowable)}>
        <div {...stylex.props(styles.flexCenterNarrowable)}>
          <h1 {...stylex.props(styles.smSemiboldTruncate)}>{title}</h1>
          {badge ? (
            <span {...stylex.props(styles.tightCapsMeta)}>
              {badge}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <p {...stylex.props(styles.capsMetaMicro)}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {status ? (
        <div
          aria-live="polite"
          {...stylex.props(styles.hiddenCenterTight)}
          data-editor-header-status={statusTone}
        >
          <span
            aria-hidden="true"
            {...stylex.props(styles.round, STATUS_TONE_STYLES[statusTone])}
          />
          {status}
        </div>
      ) : null}
      {actions ? <div {...stylex.props(styles.flexCenterTight)}>{actions}</div> : null}
    </header>
  );
}

/** A small instrument-panel readout that can sit above or below the canvas. */
export function ScenarioEditorReadout({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(stylex.props(styles.capsMetaMicro2).className, className)}
    >
      {children}
    </div>
  );
}
