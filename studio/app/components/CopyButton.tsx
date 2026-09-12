"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { mergeStyleProps } from "@simforge-oss/studio-ui/components/stylex";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./CopyButton.stylex";
export function CopyButton({
  text,
  title = "Copy to clipboard",
  label,
  className,
}: {
  text: string;
  title?: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  if (label) {
    return (
      <button
        type="button"
        onClick={copy}
        title={title}
        {...mergeStyleProps(stylex.props(styles.button, styles.compact), className)}
      >
        {copied ? (
          <Check {...stylex.props(styles.compactIcon, styles.copiedIcon)} />
        ) : (
          <Copy {...stylex.props(styles.compactIcon)} />
        )}
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      {...mergeStyleProps(stylex.props(styles.button), className)}
    >
      {copied ? (
        <Check {...stylex.props(styles.iconOnlyIcon, styles.copiedIcon)} />
      ) : (
        <Copy {...stylex.props(styles.iconOnlyIcon)} />
      )}
    </button>
  );
}
