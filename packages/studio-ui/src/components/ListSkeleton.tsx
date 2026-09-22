import * as stylex from "@stylexjs/stylex";
import { styles } from "./ListSkeleton.stylex";

/** Compact list-shaped progress, never a route-sized cloud plate. */
export function ListSkeleton({ rows = 5, label = "Loading list", xstyle }: { rows?: number; label?: string; xstyle?: stylex.StyleXStyles }) {
  return <div role="status" aria-label={label} aria-busy="true" {...stylex.props(styles.root, xstyle)}>{Array.from({ length: rows }, (_, index) => <div key={index} aria-hidden="true" {...stylex.props(styles.row)}><div {...stylex.props(styles.title)} /><div {...stylex.props(styles.detail)} /></div>)}</div>;
}
