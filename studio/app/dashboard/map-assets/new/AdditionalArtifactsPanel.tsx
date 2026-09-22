import * as stylex from "@stylexjs/stylex";
import { styles } from "./AdditionalArtifactsPanel.stylex";
import { Paperclip } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { artifactTypeFromExtension } from "@/app/lib/maps/frontend/add-map-utils";
import { UploadStatusBadge, type TrackedUpload } from "./UploadStatusBadge";

interface AdditionalArtifactsPanelProps {
  files: File[];
  uploads: Record<string, TrackedUpload>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFilesChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/** Optional extra artifacts (FBX, MP4, images) beyond the three required map files. */
export function AdditionalArtifactsPanel({
  files,
  uploads,
  inputRef,
  onFilesChange,
}: AdditionalArtifactsPanelProps) {
  return (
    <div {...stylex.props(styles.artifactsPanel)}>
      <h2 {...stylex.props(styles.artifactsHeading)}>Additional artifacts</h2>
      <p {...stylex.props(styles.artifactsDescription)}>
        Optional. Extra media or formats (e.g. .fbx, .mp4, images) beyond the three required files above.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip {...stylex.props(styles.attachmentIcon)} />
        {files.length > 0 ? "Add more files" : "Choose files"}
      </Button>
      <input
        id="map-artifacts"
        type="file"
        multiple
        ref={inputRef}
        {...stylex.props(styles.fileInput)}
        onChange={onFilesChange}
      />
      {files.length > 0 && (
        <ul {...stylex.props(styles.artifactsList)}>
          {files.map((f, i) => (
            <li key={f.name} {...stylex.props(styles.artifactItem)}>
              <span {...stylex.props(styles.artifactFilename)}>{f.name}</span>
              <Badge variant="outline" xstyle={styles.artifactTypeBadge}>
                {artifactTypeFromExtension(f.name) ?? "?"}
              </Badge>
              <UploadStatusBadge upload={uploads[`artifact-${i}`]} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
