import * as stylex from "@stylexjs/stylex";
import { styles } from "./FieldLabel.stylex";
/** Reusable form field label with optional required asterisk. */
export function FieldLabel({ htmlFor, children, required }: { htmlFor?: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} {...stylex.props(styles.fieldLabel)}>
      {children}
      {required && <span {...stylex.props(styles.requiredIndicator)}>*</span>}
    </label>
  );
}
