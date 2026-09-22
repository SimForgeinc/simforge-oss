import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";
import { styles } from "./Keycap.stylex";
import { hairline } from "../stylex/recipes.stylex";

export function Keycap({ xstyle, ...props }: Omit<ComponentProps<"kbd">, "className" | "style"> & { xstyle?: stylex.StyleXStyles }) {
  return <kbd {...props} {...stylex.props([hairline.all, styles.keycap], xstyle)} />;
}
