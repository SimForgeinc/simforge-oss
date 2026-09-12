import * as stylex from "@stylexjs/stylex";
import { styles } from "./map-assets.stylex";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";

type MapAssetDangerZoneProps = {
  dangerOpen: boolean;
  deleteBusy: boolean;
  deleteConfirmEmail: string;
  deleteError: string | null;
  sessionEmail: string | null;
  sessionLoaded: boolean;
  submitting: boolean;
  onDeleteConfirmEmailChange: (next: string) => void;
  onDeleteMap: () => void;
  onToggleDangerOpen: () => void;
};

function emailsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function MapAssetDangerZone({
  dangerOpen,
  deleteBusy,
  deleteConfirmEmail,
  deleteError,
  sessionEmail,
  sessionLoaded,
  submitting,
  onDeleteConfirmEmailChange,
  onDeleteMap,
  onToggleDangerOpen,
}: MapAssetDangerZoneProps) {
  return (
    <section className={stylex.props(styles.s_140).className}>
      <button
        type="button"
        onClick={onToggleDangerOpen}
        className={stylex.props(styles.s_141).className}
      >
        <AlertTriangle className={stylex.props(styles.s_142).className} aria-hidden />
        <h3 className={stylex.props(styles.s_143).className}>
          Delete map
        </h3>
        <ChevronDown
          className={`size-3.5 shrink-0 text-destructive/70 transition-transform duration-150 ${dangerOpen ? "rotate-180" : ""}`}
        />
      </button>
      {dangerOpen && (
        <div className={stylex.props(styles.s_716).className}>
          <p className={stylex.props(styles.s_145).className}>
            This permanently removes the map, all stored artifacts in S3 under this asset, and computed metadata
            (including stats). Existing scenarios that reference this map will point at a missing asset. This
            cannot be undone.
          </p>
          {sessionLoaded && !sessionEmail && (
            <p className={stylex.props(styles.s_151).className}>
              Your account has no email address on file. Please update your account settings to enable map deletion.
            </p>
          )}
          {sessionEmail && (
            <>
              <p className={stylex.props(styles.s_147).className}>
                Type your signed-in email address below to confirm (case does not matter):
              </p>
              <p className={stylex.props(styles.s_148).className}>
                {sessionEmail}
              </p>
              <label htmlFor="delete-confirm-email" className={stylex.props(styles.s_997).className}>
                Type your email to confirm deletion
              </label>
              <Input
                id="delete-confirm-email"
                value={deleteConfirmEmail}
                onChange={(e) => onDeleteConfirmEmailChange(e.target.value)}
                placeholder="Type your email to confirm"
                autoComplete="off"
                className={stylex.props(styles.s_150).className}
                disabled={deleteBusy}
              />
            </>
          )}
          {deleteError && <p className={stylex.props(styles.s_151).className}>{deleteError}</p>}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className={stylex.props(styles.s_708).className}
            disabled={
              deleteBusy ||
              !sessionEmail ||
              !emailsMatch(deleteConfirmEmail, sessionEmail) ||
              submitting
            }
            onClick={() => void onDeleteMap()}
          >
            {deleteBusy ? "Deleting…" : "Delete map permanently"}
          </Button>
        </div>
      )}
    </section>
  );
}
