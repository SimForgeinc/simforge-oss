import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";
import { styles } from "./Keycap.stylex";

export function Keycap({ xstyle, ...props }: Omit<ComponentProps<"kbd">, "className" | "style"> & { xstyle?: stylex.StyleXStyles }) {
  return <kbd {...props} {...stylex.props(styles.keycap, xstyle)} />;
}
