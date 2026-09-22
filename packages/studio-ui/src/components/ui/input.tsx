import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { input as inputStyles, inputSizes, inputVariants } from "./form-controls.stylex";

type InputStyle = stylex.StyleXStyles;
export type InputSize = "xs" | "sm" | "md" | "lg";
export type InputVariant = "default" | "plate";
type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  /** Height on the shared control scale. Defaults to `lg`. */
  size?: InputSize;
  variant?: InputVariant;
  /** The native `size` attribute (width in characters), renamed. */
  htmlSize?: number;
  xstyle?: InputStyle;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, style, type, size, variant = "default", htmlSize, xstyle, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    size={htmlSize}
    {...props}
    {...mergeStyleProps(stylex.props(inputStyles.base, inputStyles.file, size && inputSizes[size], inputVariants[variant], xstyle), className, style)}
  />
));
Input.displayName = "Input";

export { Input };
