"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { formatBytes } from "../scenario/scene/map-load-progress";
import { onboarding } from "./onboarding.stylex";

/**
 * The contact sheet of maps, shared by the two surfaces that offer maps: the
 * onboarding setup step and the map library.
 *
 * A map is something you recognise by looking at it, so the thumbnail *is*
 * the card and the name, the locality and the size ride over it on a scrim.
 * What differs between the two surfaces is only what the card is asking for —
 * a tick box during first-run setup, an install button in the library — so
 * that arrives as the `control`, `tag` and `status` slots rather than as a
 * second copy of this grid.
 */

export type MapGridMap = {
  mapVersionId: string;
  label: string;
  locality: string | null;
  thumbnailUrl: string | null;
  /** Download size of the closure, or null while the plan is unknown. */
  bytes: number | null;
};

export function MapGrid({ children, testId, xstyle }: { children: ReactNode; testId: string; xstyle?: stylex.StyleXStyles }) {
  return (
    <ul {...stylex.props(onboarding.mapList, xstyle)} data-testid={testId}>
      {children}
    </ul>
  );
}

export function MapCard({
  map,
  as: Element = "div",
  testId,
  locked = false,
  required = false,
  selected = false,
  installed = false,
  control,
  tag,
  status,
}: {
  map: MapGridMap;
  /**
   * `label` when the whole card is the hit area of the control in its corner
   * (the setup step's tick box); `div` when the card carries buttons of its
   * own, which may not be wrapped in a label.
   */
  as?: "div" | "label";
  testId: string;
  /** An account map without a signed-in session: shown, not actionable. */
  locked?: boolean;
  /** Part of every installation, so not a choice. */
  required?: boolean;
  selected?: boolean;
  /** The complete closure is on this computer. */
  installed?: boolean;
  /** The card's top-left corner: a tick box, a check, a lock, a spinner. */
  control?: ReactNode;
  /** The card's top-right badge: "Included", "Installed", "Sign in to unlock". */
  tag?: ReactNode;
  /** Replaces the size in the caption: progress, or the card's own actions. */
  status?: ReactNode;
}) {
  // Selected, included and installed all read as the accent border, because
  // they mean the same thing to the download that follows; only the corner
  // control and the badge say which of them it is.
  const chosen = selected || required || installed;
  return (
    <li {...stylex.props(onboarding.mapListItem)}>
      <Element
        {...stylex.props(
          onboarding.mapCard,
          locked
            ? onboarding.mapCardLocked
            : chosen
              ? Element === "label"
                ? onboarding.mapCardSelected
                : onboarding.mapCardIncluded
              : onboarding.mapCardIdle,
        )}
        data-installed={installed || undefined}
        data-locked={locked || undefined}
        data-map-version-id={map.mapVersionId}
        data-required={required || undefined}
        data-selected={selected || undefined}
        data-testid={testId}
      >
        {/* The card *is* the thumbnail: the image fills a box the grid has
            already sized, so it cannot reflow the row as it decodes, and the
            caption rides over it on a scrim rather than taking height away
            from it. */}
        <span {...stylex.props(onboarding.mapCardThumbnail)}>
          {map.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- host-served thumbnail, no loader needed
            <img alt="" {...stylex.props(onboarding.thumbnailImage)} src={map.thumbnailUrl} />
          ) : null}
        </span>
        <span {...stylex.props(onboarding.mapCardScrim)} aria-hidden="true" />
        {control ? <span {...stylex.props(onboarding.mapCardControl)}>{control}</span> : null}
        {tag}
        <span {...stylex.props(onboarding.mapCardText)}>
          <span {...stylex.props(onboarding.mapCardLabel)}>{map.label}</span>
          <span {...stylex.props(onboarding.mapCardFooter)}>
            <span {...stylex.props(onboarding.mapCardLocality)}>
              {map.locality ?? "Unknown locality"}
            </span>
            {status ?? (
              <span {...stylex.props(onboarding.mapCardSize)}>
                {map.bytes === null ? "—" : formatBytes(map.bytes)}
              </span>
            )}
          </span>
        </span>
      </Element>
    </li>
  );
}
