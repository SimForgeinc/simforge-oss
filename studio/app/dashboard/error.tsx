"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./error.stylex";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div {...stylex.props(styles.root)}>
      <h2 {...stylex.props(styles.heading)}>Something went wrong</h2>
      <p {...stylex.props(styles.message)}>
        {error.message || "An unexpected error occurred."}
      </p>
      <button onClick={reset} {...stylex.props(styles.retry)}>
        Try again
      </button>
    </div>
  );
}
