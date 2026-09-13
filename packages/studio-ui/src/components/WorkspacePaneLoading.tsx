import * as stylex from "@stylexjs/stylex";
import { LoaderCircle } from "lucide-react";
import { mergeStyleProps, type XStyle } from "./stylex/surface";
import { styles } from "./WorkspacePaneLoading.stylex";

export type WorkspacePaneLoadingProps = {
  message: string;
  hint?: string;
  className?: string;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
};

export function WorkspacePaneLoading({ message, hint, className, xstyle }: WorkspacePaneLoadingProps) {
  return (
    <div aria-busy="true" aria-live="polite" {...mergeStyleProps(stylex.props(styles.root, xstyle), className)} data-testid="workspace-pane-loading" role="status">
      <span aria-hidden="true" {...stylex.props(styles.spinner)}>
        <LoaderCircle {...stylex.props(styles.icon)} />
      </span>
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.message)}>{message}</p>
        {hint ? <p {...stylex.props(styles.hint)}>{hint}</p> : null}
      </div>
    </div>
  );
}
