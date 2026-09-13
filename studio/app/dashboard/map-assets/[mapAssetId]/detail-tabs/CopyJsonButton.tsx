"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../../map-assets.stylex";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@simforge-oss/studio-ui/components/ui/tooltip";

interface CopyJsonButtonProps {
  /** Object serialised to pretty-printed JSON on click. */
  payload: unknown;
  /** Disable when there's nothing useful to copy. */
  disabled?: boolean;
  /**
   * Tooltip + aria-label phrasing. Defaults to "Copy as JSON" — pass
   * something more specific (e.g. "Copy results as JSON") for clarity.
   */
  label?: string;
}

/**
 * Icon button that serialises `payload` to pretty-printed JSON and writes it
 * to the clipboard on click. Used by the keyword search results header.
 *
 * The Async Clipboard API is unavailable in non-secure contexts and older
 * browsers; both the presence check and the call itself are guarded so a
 * missing API degrades silently instead of throwing on click.
 */
export function CopyJsonButton({
  payload,
  disabled = false,
  label = "Copy as JSON",
}: CopyJsonButtonProps) {
  const [copied, setCopied] = useState(false);
  const clipboardAvailable =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function";

  function handleCopy() {
    if (!clipboardAvailable) return;
    const json = JSON.stringify(payload, null, 2);
    try {
      navigator.clipboard
        .writeText(json)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    } catch {
      /* clipboard rejected synchronously — leave the icon unchanged */
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            disabled={disabled || !clipboardAvailable}
            aria-label={label}
            className={stylex.props(styles.copyJsonButton).className}
          >
            {copied ? (
              <Check className={stylex.props(styles.s_808).className} aria-hidden="true" />
            ) : (
              <Copy className={stylex.props(styles.s_991).className} aria-hidden="true" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {copied
            ? "Copied!"
            : clipboardAvailable
              ? label
              : "Clipboard unavailable in this context"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
