"use client";

import type { CSSProperties, ReactNode } from "react";
import { Check, CircleAlert, Download, LoaderCircle, Lock, LogIn, RotateCcw } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "../components/ui/button";
import { PaneErrorState } from "../components/state-frames";
import { ListSkeleton } from "../components/ListSkeleton";
import { EmptyState } from "../components/ui/empty-state";
import { styles } from "./MapLibraryScreen.stylex";
import { formatBytes } from "../scenario/scene/map-load-progress";
import { MapCard, MapGrid, type MapGridMap } from "./MapGrid";
import { installRows, library, onboarding, PROGRESS_VAR } from "./onboarding.stylex";

/**
 * The map library: what this computer has, what it can still get, and one
 * button per map to get it.
 *
 * First-run setup asks the same question once, as a wizard step that ends by
 * finishing the installation. This is that question asked at any time, with
 * no completion behind it: maps are installed and re-installed from here for
 * as long as the application is used. It is the same screen frame, the same
 * contact sheet and the same hero as the setup step on purpose — the flow
 * from the download page through first run to adding a map later is one
 * surface, not three that resemble each other.
 *
 * Props only: the host owns the catalog, the install jobs and the session.
 */

/** One map's live install, as {@link useMapPreparation} reports it. */
export type MapLibraryInstall = {
  state: "pending" | "installing" | "ready" | "error" | "skipped";
  completedBytes: number;
  bytes: number;
  message: string | null;
};

export type MapLibraryMap = MapGridMap & {
  /** An account map with no active session: listed, not installable. */
  locked: boolean;
  /** The complete verified closure is on this computer. */
  installed: boolean;
  /** The install this session started (or rejoined), while there is one. */
  install: MapLibraryInstall | null;
};

/** The word for a card's state, in the badge over its thumbnail. */
function stateLabel(map: MapLibraryMap, catalog: boolean): string {
  if (catalog) return map.locked ? "Not in your plan" : "Available";
  if (map.install?.state === "installing") return "Installing";
  if (map.install?.state === "pending") return "Queued";
  if (map.install?.state === "error") return "Failed";
  if (map.installed) return "Installed";
  if (map.locked) return "Sign in to unlock";
  return "Available";
}

export function MapLibraryScreen({
  maps,
  loading,
  error,
  catalogError,
  freeBytes,
  onInstall,
  catalog = false,
  signedIn,
  signIn,
  onSignIn,
  onCancelSignIn,
  onRetry,
}: {
  maps: readonly MapLibraryMap[];
  loading: boolean;
  error: string | null;
  /** Why the list may be short: the Cloud did not answer for the catalog. */
  catalogError: string | null;
  freeBytes: number | null;
  /** Install, re-install or retry exactly this map; the host owns the queue. */
  onInstall: (mapVersionId: string) => void;
  /**
   * Read-only: the maps this deployment publishes, with no residency on any
   * disk to report and nothing to download. A hosted deployment streams every
   * map it lists, so "installed", download sizes, free space and the install
   * control are not disabled here — they have no subject.
   */
  catalog?: boolean;
  signedIn: boolean;
  /** The host's sign-in flow, once the user asked for it. */
  signIn?: ReactNode;
  onSignIn: () => void;
  onCancelSignIn?: () => void;
  onRetry?: () => void;
}) {
  const installed = maps.filter((map) => map.installed);
  const installedBytes = installed.reduce((total, map) => total + (map.bytes ?? 0), 0);
  const lockedCount = maps.filter((map) => map.locked).length;
  const failed = maps.filter((map) => map.install?.state === "error");
  const empty = !loading && maps.length === 0;

  return (
    <section {...stylex.props(styles.frame)} data-testid="map-library">
      <header {...stylex.props(onboarding.stepHeader)}>
        <h2 {...stylex.props(onboarding.eyebrow)}>Map availability</h2>
        <p {...stylex.props(onboarding.welcomeLede)}>
          {catalog
            ? "Every map this workspace can open. They stream straight into the editor, the viewer and rendering — there is nothing to download first."
            : "Every map this installation can use. Installed maps are downloaded once and shared by the editor, the viewer and local rendering; installing again repairs a map whose files were removed or whose cache was cleared."}
        </p>
      </header>

      <div {...stylex.props(styles.catalog)}>
        {loading ? (
          <ListSkeleton label="Loading the map catalog" />
        ) : empty && (error || catalogError) ? (
          <PaneErrorState title="Could not load the map catalog" description={error ?? catalogError} onRetry={onRetry} exitHref="/dashboard/apps" />
        ) : empty ? (
          <EmptyState title="No maps available" description={catalog ? "No maps have been published to this workspace." : "No maps have been published for this installation."} />
        ) : (
          <MapGrid testId="map-library-list" xstyle={styles.grid}>
            {maps.map((map) => {
              const running = map.install?.state === "installing" || map.install?.state === "pending";
              const percent = map.install && map.install.bytes > 0
                ? Math.min(100, Math.round((100 * map.install.completedBytes) / map.install.bytes))
                : 0;
              return (
                <MapCard
                  as="div"
                  control={
                    running ? (
                      <LoaderCircle {...stylex.props(onboarding.iconSmall, onboarding.spinner)} aria-hidden="true" />
                    ) : map.install?.state === "error" ? (
                      <CircleAlert {...stylex.props(onboarding.iconSmall, onboarding.iconDanger)} aria-hidden="true" />
                    ) : !catalog && map.installed ? (
                      <Check {...stylex.props(onboarding.iconSmall, onboarding.iconAccent)} aria-hidden="true" />
                    ) : map.locked ? (
                      <Lock {...stylex.props(onboarding.iconSmall, onboarding.iconMuted)} aria-hidden="true" />
                    ) : (
                      <Download {...stylex.props(onboarding.iconSmall, onboarding.iconMuted)} aria-hidden="true" />
                    )
                  }
                  installed={!catalog && map.installed}
                  key={map.mapVersionId}
                  locked={map.locked}
                  map={map}
                  status={
                    <span {...stylex.props(library.cardStatus)}>
                      {running ? (
                        <>
                          {formatBytes(map.install?.completedBytes ?? 0)}
                          {map.install && map.install.bytes > 0 ? ` / ${formatBytes(map.install.bytes)}` : ""}
                          <span
                            aria-label={`${map.label} download`}
                            aria-valuemax={100}
                            aria-valuemin={0}
                            aria-valuenow={percent}
                            {...stylex.props(library.cardTrack)}
                            role="progressbar"
                          >
                            <span
                              {...stylex.props(installRows.fill)}
                              style={{ [PROGRESS_VAR]: `${percent}%` } as CSSProperties}
                            />
                          </span>
                        </>
                      ) : (
                        <>
                          {catalog ? null : map.bytes === null ? "—" : formatBytes(map.bytes)}
                          {catalog || map.locked ? null : (
                            <Button
                              xstyle={library.cardAction}
                              data-testid="map-library-install"
                              onClick={() => onInstall(map.mapVersionId)}
                              type="button"
                              variant="outline"
                            >
                              {map.install?.state === "error" ? (
                                <RotateCcw {...stylex.props(onboarding.iconSmall, onboarding.iconWithLabel)} aria-hidden="true" />
                              ) : null}
                              {map.install?.state === "error" ? "Retry" : map.installed ? "Reinstall" : "Install"}
                            </Button>
                          )}
                        </>
                      )}
                    </span>
                  }
                  tag={
                    <span
                      {...stylex.props(
                        onboarding.mapCardTag,
                        !catalog && map.install?.state === "error"
                          ? library.tagFailed
                          : !catalog && map.installed
                            ? onboarding.includedTag
                            : library.tagAvailable,
                      )}
                      data-testid="map-library-state"
                    >
                      {stateLabel(map, catalog)}
                    </span>
                  }
                  testId="map-library-card"
                />
              );
            })}
          </MapGrid>
        )}
        {failed.map((map) => (
          <p key={map.mapVersionId} {...stylex.props(library.failure)} role="alert" data-testid="map-library-failure">
            <CircleAlert {...stylex.props(onboarding.icon, onboarding.iconDanger)} aria-hidden="true" />
            {map.install?.message ?? `${map.label} could not be installed.`}
          </p>
        ))}
      </div>

      <div {...stylex.props(onboarding.stepFooter)}>
        {catalog ? (
          <dl {...stylex.props(onboarding.summaryLine)}>
            <dt {...stylex.props(onboarding.summaryTerm)}>Maps</dt>
            <dd {...stylex.props(onboarding.summaryValue)} data-testid="map-library-count">
              {maps.length}
            </dd>
          </dl>
        ) : (
        <dl {...stylex.props(onboarding.summaryLine)}>
          <dt {...stylex.props(onboarding.summaryTerm)}>Installed</dt>
          <dd {...stylex.props(onboarding.summaryValue)} data-testid="map-library-installed-count">
            {installed.length} of {maps.length} · {formatBytes(installedBytes)}
          </dd>
          <dt {...stylex.props(onboarding.summaryTerm)}>Free disk</dt>
          <dd {...stylex.props(onboarding.summaryValue)} data-testid="map-library-free-bytes">
            {freeBytes === null ? "Unknown" : formatBytes(freeBytes)}
          </dd>
        </dl>
        )}

        {!empty && (error || catalogError) ? (
          <PaneErrorState title="Could not refresh the map catalog" description={error ?? catalogError} onRetry={onRetry} exitHref="/dashboard/apps" />
        ) : null}

        {signedIn || signIn ? null : (
          <div {...stylex.props(onboarding.welcomeActions)}>
            <Button
              xstyle={onboarding.secondaryAction}
              data-testid="map-library-sign-in"
              onClick={onSignIn}
              type="button"
              variant="outline"
            >
              <LogIn {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
              Sign in to SimCloud
            </Button>
          </div>
        )}
        {signIn ? (
          <div {...stylex.props(onboarding.signInSlot)} data-testid="map-library-sign-in-flow">
            {signIn}
            {onCancelSignIn ? (
              <Button
                xstyle={onboarding.signInDismiss}
                data-testid="map-library-sign-in-cancel"
                onClick={onCancelSignIn}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        <p {...stylex.props(onboarding.footnote)}>
          {signedIn
            ? "Every map your account can read is listed here."
            : lockedCount > 0
              ? `Sign in to unlock ${lockedCount} more ${lockedCount === 1 ? "map" : "maps"} from your SimCloud account.`
              : "Sign in any time to add the maps in your SimCloud account."}
        </p>
      </div>
    </section>
  );
}
