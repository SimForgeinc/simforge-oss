import * as stylex from "@stylexjs/stylex";
import { space } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // min-w-0 flex-1 whitespace-pre-wrap break-words
  span: {
    minWidth: 0,
    flex: "1 1 0%",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  },
  // size-3
  checkIcon: {
    width: space.s3,
    height: space.s3,
  },
  // size-3
  copyIcon: {
    width: space.s3,
    height: space.s3,
  },
});
