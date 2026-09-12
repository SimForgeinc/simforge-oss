import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";
import { Loader2, Check, AlertCircle } from "lucide-react";

export type UploadStatus = "hashing" | "uploading" | "done" | "error";
export type TrackedUpload = {
  status: UploadStatus;
  sha256: string | null;
  key: string | null;
  error: string | null;
};

/** Tiny upload status indicator shown inline next to each file name. */
export function UploadStatusBadge({ upload }: { upload: TrackedUpload | undefined }) {
  if (!upload) return null;
  switch (upload.status) {
    case "hashing":
      return (
        <span className={stylex.props(styles.s_357).className}>
          <Loader2 className={stylex.props(styles.s_972).className} /> Hashing…
        </span>
      );
    case "uploading":
      return (
        <span className={stylex.props(styles.s_359).className}>
          <Loader2 className={stylex.props(styles.s_972).className} /> Uploading…
        </span>
      );
    case "done":
      return (
        <span className={stylex.props(styles.s_361).className}>
          <Check className={stylex.props(styles.s_927).className} /> Uploaded
        </span>
      );
    case "error":
      return (
        <span className={stylex.props(styles.s_363).className} title={upload.error ?? undefined}>
          <AlertCircle className={stylex.props(styles.s_927).className} /> Failed
        </span>
      );
  }
}
