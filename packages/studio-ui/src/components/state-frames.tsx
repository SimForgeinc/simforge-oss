"use client";

import { useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "./ui/button";
import { styles } from "./state-frames.stylex";

export type ErrorStateProps = {
  title: string; description?: ReactNode; onRetry?: () => void;
  exitHref?: string; exitLabel?: string; details?: string; xstyle?: stylex.StyleXStyles;
};

function ErrorFrame({ title, description, onRetry, exitHref, exitLabel = "Back to Apps", details, xstyle, route = false }: ErrorStateProps & { route?: boolean }) {
  const [copyStatus, setCopyStatus] = useState("");
  return <section role="alert" {...stylex.props(styles.root, route && styles.route, xstyle)}>
    <div {...stylex.props(styles.content)}>
      <h2 {...stylex.props(styles.title)}>{title}</h2>
      {description ? <div {...stylex.props(styles.description)}>{description}</div> : null}
      {details ? <details {...stylex.props(styles.details)}><summary>Error details</summary><pre {...stylex.props(styles.diagnostic)}>{details}</pre><Button variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(details); setCopyStatus("Copied"); } catch { setCopyStatus("Unable to copy. Select the details to copy them."); } }}>Copy details</Button><span role="status">{copyStatus}</span></details> : null}
      <div {...stylex.props(styles.actions)}>
        {onRetry ? <Button type="button" onClick={onRetry}>Retry</Button> : null}
        {exitHref ? <Button asChild variant="outline"><a href={exitHref}>{exitLabel}</a></Button> : null}
      </div>
    </div>
  </section>;
}
export function RouteErrorState(props: ErrorStateProps) { return <ErrorFrame exitHref="/dashboard/apps" {...props} route />; }
export function PaneErrorState(props: ErrorStateProps) { return <ErrorFrame {...props} />; }
