"use client";

import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";
import { Button } from "../../components/ui/button";

/** Save feedback belongs beside the document/evidence, never in the notification dock. */
export function SaveStatus({ label, status, error, onRetry }: {
  label: string;
  status?: "saving" | "saved" | "dirty" | "conflict" | null;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (!status && !error) return null;
  return (
    <div {...stylex.props(styles.line)} data-save-status={label} role="status">
      <span title={error ?? undefined}>
        {label}: {error ? "Could not save" : status === "saved" ? "Saved" : status === "conflict" ? "Changed elsewhere" : "Saving…"}
      </span>
      {error && onRetry ? <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

const styles = stylex.create({
  line: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    color: colors.mutedForeground,
    fontSize: text.sizeXs,
    flexShrink: 0,
  },
});
