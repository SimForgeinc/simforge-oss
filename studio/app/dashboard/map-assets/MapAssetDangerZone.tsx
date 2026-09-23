import * as stylex from "@stylexjs/stylex";
import { styles } from "./MapAssetDangerZone.stylex";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { a11y, hairline, motionRecipe, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

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
    <section {...stylex.props(styles.dangerZone)}>
      <button
        type="button"
        onClick={onToggleDangerOpen}
        {...stylex.props(styles.dangerToggle)}
      >
        <AlertTriangle {...stylex.props(styles.dangerIcon)} aria-hidden />
        <h3 {...stylex.props([typography.caps, styles.dangerHeading])}>
          Delete map
        </h3>
        <ChevronDown
          {...stylex.props([motionRecipe.transform, styles.dangerChevron], dangerOpen ? styles.dangerChevronOpen : null)}
        />
      </button>
      {dangerOpen && (
        <div {...stylex.props(styles.dangerContent)}>
          <p {...stylex.props(styles.deletionWarning)}>
            This permanently removes the map, all stored artifacts in S3 under this asset, and computed metadata
            (including stats). Existing scenarios that reference this map will point at a missing asset. This
            cannot be undone.
          </p>
          {sessionLoaded && !sessionEmail && (
            <p {...stylex.props(styles.dangerMessage)}>
              Your account has no email address on file. Please update your account settings to enable map deletion.
            </p>
          )}
          {sessionEmail && (
            <>
              <p {...stylex.props(styles.emailConfirmationInstruction)}>
                Type your signed-in email address below to confirm (case does not matter):
              </p>
              <p {...stylex.props([hairline.all, styles.sessionEmailDisplay])}>
                {sessionEmail}
              </p>
              <label htmlFor="delete-confirm-email" {...stylex.props(a11y.srOnly)}>
                Type your email to confirm deletion
              </label>
              <Input size="md" variant="plate"
                id="delete-confirm-email"
                value={deleteConfirmEmail}
                onChange={(e) => onDeleteConfirmEmailChange(e.target.value)}
                placeholder="Type your email to confirm"
                autoComplete="off"
                xstyle={styles.emailConfirmationInput}
                disabled={deleteBusy}
              />
            </>
          )}
          {deleteError && <p {...stylex.props(styles.dangerMessage)}>{deleteError}</p>}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            xstyle={styles.deleteButton}
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
