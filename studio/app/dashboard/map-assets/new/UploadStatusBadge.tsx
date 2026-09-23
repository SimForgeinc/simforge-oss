import * as stylex from "@stylexjs/stylex";
import { styles } from "./UploadStatusBadge.stylex";
import { Loader2, Check, AlertCircle } from "lucide-react";
import { motionRecipe } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

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
        <span {...stylex.props(styles.hashingStatus)}>
          <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingIcon])} /> Hashing…
        </span>
      );
    case "uploading":
      return (
        <span {...stylex.props(styles.uploadingStatus)}>
          <Loader2 {...stylex.props([motionRecipe.spin, styles.loadingIcon])} /> Uploading…
        </span>
      );
    case "done":
      return (
        <span {...stylex.props(styles.successStatus)}>
          <Check {...stylex.props(styles.statusIcon)} /> Uploaded
        </span>
      );
    case "error":
      return (
        <span {...stylex.props(styles.errorStatus)} title={upload.error ?? undefined}>
          <AlertCircle {...stylex.props(styles.statusIcon)} /> Failed
        </span>
      );
  }
}
