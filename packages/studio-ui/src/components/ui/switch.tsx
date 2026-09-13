"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./switch.stylex";

type SwitchStyle = stylex.StyleXStyles;

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & { xstyle?: SwitchStyle }
>(({ className, xstyle, ...props }, ref) => (
  <SwitchPrimitives.Root ref={ref} {...mergeStyleProps(stylex.props(styles.root, xstyle), className)} {...props}>
    <SwitchPrimitives.Thumb {...stylex.props(styles.thumb)} />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
