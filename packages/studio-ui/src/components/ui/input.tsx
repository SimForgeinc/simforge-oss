import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { input as inputStyles } from "./form-controls.stylex";

type InputStyle = stylex.StyleXStyles;
type InputProps = React.ComponentProps<"input"> & { xstyle?: InputStyle };

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, style, type, xstyle, ...props }, ref) => (
  <input type={type} ref={ref} {...props} {...mergeStyleProps(stylex.props(inputStyles.base, inputStyles.file, xstyle), className, style)} />
));
Input.displayName = "Input";

export { Input };
