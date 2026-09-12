import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { textarea as textareaStyles } from "./form-controls.stylex";

type TextareaStyle = stylex.StyleXStyles;
type TextareaProps = React.ComponentProps<"textarea"> & { xstyle?: TextareaStyle };

/** Multi-line sibling of `Input`, sharing its border, focus and disabled treatment. */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, style, xstyle, ...props }, ref) => (
  <textarea ref={ref} {...props} {...mergeStyleProps(stylex.props(textareaStyles.base, xstyle), className, style)} />
));
Textarea.displayName = "Textarea";

export { Textarea };
