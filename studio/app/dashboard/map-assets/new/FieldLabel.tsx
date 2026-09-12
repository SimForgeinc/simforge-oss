import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";
/** Reusable form field label with optional required asterisk. */
export function FieldLabel({ htmlFor, children, required }: { htmlFor?: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className={stylex.props(styles.s_256).className}>
      {children}
      {required && <span className={stylex.props(styles.s_257).className}>*</span>}
    </label>
  );
}
