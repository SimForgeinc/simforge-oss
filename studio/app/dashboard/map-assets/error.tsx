"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./map-assets.stylex";

export default function MapAssetsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className={stylex.props(styles.s_136).className}>
      <h2 className={stylex.props(styles.s_137).className}>Failed to load map assets</h2>
      <p className={stylex.props(styles.s_138).className}>
        {error.message || "Could not fetch map asset data."}
      </p>
      <button
        onClick={reset}
        className={stylex.props(styles.s_139).className}
      >
        Try again
      </button>
    </div>
  );
}
