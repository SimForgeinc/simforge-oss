"use client";

import * as stylex from "@stylexjs/stylex";
import { DatabaseZap } from "lucide-react";
import { useState } from "react";
import { ProfileMapPreparation } from "./ProfileMapPreparation";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { useRenderingPreference, renderingPreferenceQuality, saveRenderingPreference, type RenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import { MapAssetCacheStorage } from "@simforge-oss/studio-ui/components/MapAssetCacheStorage";
import { clearMapAssetCache } from "@simforge-oss/studio-ui/lib/maps/frontend/map-asset-cache";
import { RenderSelectionPanel } from "@simforge-oss/studio-ui/render-selection/RenderSelectionPanel";
import { styles } from "@/app/components/render-settings.stylex";

/**
 * Render Settings, inline in the app switcher: the single-page
 * `RenderSelectionPanel` (which carries its own heading) plus the cache
 * controls, swapped into the switcher's content in place of the app tabs. It
 * is not a route of its own — `onDone` hands the switcher back.
 */

type Preparation = {
  profile: RenderingPreference;
  redownload?: boolean;
};

const PROFILE_LABELS: Record<RenderingPreference, string> = {
  "low-no-foliage": "Low · no foliage",
  low: "Low",
  medium: "Medium",
};

export function RenderSettings({ onDone }: { onDone: () => void }) {
  const currentProfile = useRenderingPreference();
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [pendingProfile, setPendingProfile] =
    useState<RenderingPreference | null>(null);
  const [confirmRedownload, setConfirmRedownload] = useState(false);
  const [clearing, setClearing] = useState(false);
  const beginPreparation = (
    profile: RenderingPreference,
    redownload = false,
  ) => {
    saveRenderingPreference(profile);
    setPendingProfile(null);
    setConfirmRedownload(false);
    setPreparation({ profile, redownload });
  };

  const choose = (profile: RenderingPreference) => {
    if (currentProfile && renderingPreferenceQuality(currentProfile) === renderingPreferenceQuality(profile)) {
      saveRenderingPreference(profile);
      return;
    }
    if (currentProfile && currentProfile !== profile) {
      setPendingProfile(profile);
      return;
    }
    beginPreparation(profile);
  };

  const clearThenPrepare = async (profile: RenderingPreference) => {
    setClearing(true);
    try {
      await clearMapAssetCache();
      beginPreparation(profile, true);
    } finally {
      setClearing(false);
    }
  };

  const finish = onDone;

  return (
    <div {...stylex.props(styles.root)} data-testid="render-settings-panel">
      {preparation ? (
        <ProfileMapPreparation
          profile={preparation.profile}
          redownload={preparation.redownload}
          onContinue={finish}
          onSkip={finish}
        />
      ) : (
        <RenderSelectionPanel
          currentQuality={currentProfile ?? "low"}
          onChoose={choose}
          titleId="render-settings-title"
          descriptionId="render-settings-description"
          footer={
            <div {...stylex.props(styles.footer)}>
              <MapAssetCacheStorage compact allowClear={false} refreshKey={currentProfile} />
              {currentProfile ? (
                <div {...stylex.props(styles.footerRow)}>
                  <Button
                    xstyle={styles.cacheButton}
                    onClick={() => setConfirmRedownload(true)}
                    type="button"
                    title="Delete the shared map cache, then download this profile again."
                    variant="outline"
                  >
                    <DatabaseZap {...stylex.props(styles.icon)} aria-hidden="true" />
                    Re-download maps
                  </Button>
                  <p {...stylex.props(styles.current)}>
                    Current setting: {PROFILE_LABELS[currentProfile]}
                  </p>
                </div>
              ) : null}
            </div>
          }
        />
      )}

      {pendingProfile ? (
        <ConfirmationPanel
          title={`Switch to ${PROFILE_LABELS[pendingProfile]}?`}
          detail="You can keep the shared cache and download only missing files, or delete it first for a clean download."
          busy={clearing}
          primaryLabel="Delete cache and continue"
          secondaryLabel="Keep cache and continue"
          onCancel={() => setPendingProfile(null)}
          onPrimary={() => void clearThenPrepare(pendingProfile)}
          onSecondary={() => beginPreparation(pendingProfile)}
        />
      ) : null}

      {confirmRedownload && currentProfile ? (
        <ConfirmationPanel
          title="Delete the complete map cache?"
          detail={`All cached map assets will be removed, then the ${PROFILE_LABELS[currentProfile]} library will be downloaded again.`}
          busy={clearing}
          primaryLabel="Delete and re-download"
          onCancel={() => setConfirmRedownload(false)}
          onPrimary={() => void clearThenPrepare(currentProfile)}
        />
      ) : null}
    </div>
  );
}

function ConfirmationPanel({
  title,
  detail,
  busy,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onCancel,
}: {
  title: string;
  detail: string;
  busy: boolean;
  primaryLabel: string;
  secondaryLabel?: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      {...stylex.props(styles.overlay)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cache-confirmation-title"
    >
      <div {...stylex.props(styles.dialog)}>
        <h2 id="cache-confirmation-title" {...stylex.props(styles.dialogTitle)}>
          {title}
        </h2>
        <p {...stylex.props(styles.dialogDetail)}>{detail}</p>
        <div {...stylex.props(styles.dialogActions)}>
          <Button
            xstyle={styles.primaryButton}
            disabled={busy}
            onClick={onPrimary}
          >
            {busy ? "Clearing cache…" : primaryLabel}
          </Button>
          {secondaryLabel && onSecondary ? (
            <Button
              xstyle={styles.secondaryButton}
              disabled={busy}
              onClick={onSecondary}
              variant="outline"
            >
              {secondaryLabel}
            </Button>
          ) : null}
          <Button
            xstyle={styles.cancelButton}
            disabled={busy}
            onClick={onCancel}
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
