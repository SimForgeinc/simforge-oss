import * as stylex from "@stylexjs/stylex";
import { LoaderCircle } from "lucide-react";
import { mergeStyleProps } from "./stylex/surface";
import { styles } from "./WorkspacePaneLoading.stylex";

export type WorkspacePaneLoadingProps = { message: string; hint?: string; className?: string };

export function WorkspacePaneLoading({ message, hint, className }: WorkspacePaneLoadingProps) {
  return (
    <div aria-busy="true" aria-live="polite" {...mergeStyleProps(stylex.props(styles.root), className)} data-testid="workspace-pane-loading" role="status">
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
