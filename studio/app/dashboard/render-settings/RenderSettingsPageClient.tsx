"use client";

import * as stylex from "@stylexjs/stylex";
import { studioHost } from "@/app/lib/host";
import { DatabaseZap } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ProfileMapPreparation } from "@/app/components/ProfileMapPreparation";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { readRenderingPreference, saveRenderingPreference, type RenderingPreference } from "@simforge-oss/studio-ui/components/rendering-preference";
import { QualityChooser } from "@simforge-oss/studio-ui/scenario/editor/states/EditorStatePanels";
import type { ScenarioMapOption } from "@simforge-oss/studio-ui/scenario/list/document-map-groups";
import { clearMapAssetCache } from "@simforge-oss/studio-ui/lib/maps/frontend/map-asset-cache";
import { styles } from "./render-settings-page.stylex";
type Preparation = {
  profile: RenderingPreference;
  redownload?: boolean;
};

const PROFILE_LABELS: Record<RenderingPreference, string> = {
  "roads-only": "Roads Only",
  "ultra-low-3d": "Low",
  minimal: "Balanced",
  high: "High",
};

const RenderingBenchmarkCard = dynamic(
  () =>
    import("@simforge-oss/studio-ui/scenario/editor/regions/slots/RenderingBenchmark").then(
      (module) => module.RenderingBenchmarkCard,
    ),
  { ssr: false },
);

export function RenderSettingsPageClient() {
  useSetPageTitle("Render Settings");
  const router = useRouter();
  const [currentProfile, setCurrentProfile] =
    useState<RenderingPreference | null>(null);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [pendingProfile, setPendingProfile] =
    useState<RenderingPreference | null>(null);
  const [confirmRedownload, setConfirmRedownload] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [benchmarkTarget, setBenchmarkTarget] =
    useState<ScenarioMapOption | null>(null);
  const [benchmarkCatalogReady, setBenchmarkCatalogReady] = useState(false);

  useEffect(() => setCurrentProfile(readRenderingPreference()), []);

  useEffect(() => {
    const controller = new AbortController();
    void studioHost.artifacts.listMaps(controller.signal)
      .then((maps) => {
        if (controller.signal.aborted) return;
        setBenchmarkTarget(
          maps.find((map) => Boolean(map.browserManifestUrl)) ?? null,
        );
        setBenchmarkCatalogReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBenchmarkCatalogReady(true);
      });
    return () => controller.abort();
  }, []);

  const beginPreparation = (
    profile: RenderingPreference,
    redownload = false,
  ) => {
    saveRenderingPreference(profile);
    setCurrentProfile(profile);
    setPendingProfile(null);
    setConfirmRedownload(false);
    setPreparation({ profile, redownload });
  };

  const choose = (profile: RenderingPreference) => {
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

  const finish = () => router.push("/dashboard/map-assets");

  return (
    <div {...stylex.props(styles.root)}>
      <SkyCloudBackdrop className="absolute" />
      <div {...stylex.props(styles.scroll)}>
        {preparation ? (
          <ProfileMapPreparation
            profile={preparation.profile}
            redownload={preparation.redownload}
            onContinue={finish}
            onSkip={finish}
          />
        ) : (
          <QualityChooser
            onChoose={choose}
            titleId="render-settings-title"
            descriptionId="render-settings-description"
            benchmark={
              benchmarkTarget?.browserManifestUrl ? (
                <RenderingBenchmarkCard
                  manifestUrl={benchmarkTarget.browserManifestUrl}
                  mapLabel={benchmarkTarget.label}
                  currentQuality={currentProfile ?? "minimal"}
                  onApply={choose}
                />
              ) : (
                <div
                  {...stylex.props(styles.benchmark)}
                  data-testid="rendering-benchmark-placeholder"
                  data-visual-treatment="flat"
                >
                  <p {...stylex.props(styles.eyebrow)}>
                    Benchmark
                  </p>
                  <p {...stylex.props(styles.benchmarkTitle)}>
                    {benchmarkCatalogReady
                      ? "Benchmark unavailable"
                      : "Preparing benchmark…"}
                  </p>
                  <p {...stylex.props(styles.benchmarkCopy)}>
                    {benchmarkCatalogReady
                      ? "Choose a rendering mode below."
                      : "Selecting a test map automatically."}
                  </p>
                </div>
              )
            }
            footer={
              currentProfile ? (
                <div {...stylex.props(styles.footer)}>
                  <Button
                    xstyle={styles.cacheButton}
                    onClick={() => setConfirmRedownload(true)}
                    type="button"
                    variant="outline"
                  >
                    <DatabaseZap {...stylex.props(styles.icon)} aria-hidden="true" />
                    Delete cache and re-download{" "}
                    {PROFILE_LABELS[currentProfile]}
                  </Button>
                  <p {...stylex.props(styles.current)}>
                    Current setting: {PROFILE_LABELS[currentProfile]}
                  </p>
                </div>
              ) : null
            }
          />
        )}
      </div>

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
