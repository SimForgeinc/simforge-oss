"use client";

import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { mergeStyleProps } from "../stylex/surface";
import { separator as separatorStyles } from "./layout.stylex";

type SeparatorStyle = stylex.StyleXStyles;
type SeparatorProps = React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> & { xstyle?: SeparatorStyle };

const Separator = React.forwardRef<React.ElementRef<typeof SeparatorPrimitive.Root>, SeparatorProps>(
  ({ className, style, orientation = "horizontal", decorative = true, xstyle, ...props }, ref) => (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      {...props}
      {...mergeStyleProps(
        stylex.props(separatorStyles.base, orientation === "horizontal" ? separatorStyles.horizontal : separatorStyles.vertical, xstyle),
        className,
        style,
      )}
    />
  ),
);
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
