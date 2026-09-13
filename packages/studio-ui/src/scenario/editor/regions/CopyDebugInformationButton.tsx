"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { useCopyToClipboard } from "../../list/CopyableErrorMessage";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./CopyDebugInformationButton.stylex";

export function CopyDebugInformationButton({
  getDebugInformation,
  xstyle,
}: {
  getDebugInformation: () => string;
  /**
   * Caller StyleX styles for the button, composed after this component's own
   * and `Button`'s. They cannot travel as a `className`: `Button` compiles its
   * own geometry with StyleX, and a concatenated class loses to it.
   */
  xstyle?: stylex.StyleXStyles;
}) {
  const { copied, copy } = useCopyToClipboard(2000);

  return (
    <Button
      aria-label={copied ? "Debug information copied" : "Copy debug information"}
      xstyle={[styles.borderedGlassyGap2, xstyle]}
      onClick={() => copy(getDebugInformation())}
      size="sm"
      title="Copy scenario and editor diagnostics for a support ticket"
      type="button"
      variant="outline"
    >
      {copied ? (
        <Check aria-hidden="true" className={stylex.props(styles.size4TextEmerald400).className} />
      ) : (
        <Copy aria-hidden="true" className={stylex.props(styles.size4).className} />
      )}
      <span>{copied ? "Copied debug information" : "Copy debug information"}</span>
    </Button>
  );
}
