import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";
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
    <div className={stylex.props(styles.s_258).className}>
      <h2 className={stylex.props(styles.s_259).className}>Additional artifacts</h2>
      <p className={stylex.props(styles.s_260).className}>
        Optional. Extra media or formats (e.g. .fbx, .mp4, images) beyond the three required files above.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip className={stylex.props(styles.s_596).className} />
        {files.length > 0 ? "Add more files" : "Choose files"}
      </Button>
      <input
        id="map-artifacts"
        type="file"
        multiple
        ref={inputRef}
        className={stylex.props(styles.s_373).className}
        onChange={onFilesChange}
      />
      {files.length > 0 && (
        <ul className={stylex.props(styles.s_263).className}>
          {files.map((f, i) => (
            <li key={f.name} className={stylex.props(styles.s_264).className}>
              <span className={stylex.props(styles.s_941).className}>{f.name}</span>
              <Badge variant="outline" className={stylex.props(styles.s_266).className}>
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
