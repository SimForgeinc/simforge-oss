"use client";

import { CircleAlert, LoaderCircle, MapPin } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { driveChrome } from "./chrome";
import { driveColors, driveRadius, driveText } from "./drive.stylex";

/** One installed map offered as a place to drive. */
export interface DriveMapOption {
  mapVersionId: string;
  label: string;
  locality: string | null;
  thumbnailUrl: string | null;
}

/** The loader's turn. One revolution per second, as Tailwind's `animate-spin` was. */
const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  /** The screen's own gutters: the chrome supplies the field, this the frame. */
  screen: {
    paddingInline: { default: "1.5rem", "@media (min-width: 640px)": "2.5rem" },
    paddingBlock: "3rem",
  },
  column: {
    marginInline: "auto",
    width: "100%",
    maxWidth: "64rem",
  },

  /** The game's name, in the accent, above the ask. */
  eyebrow: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    fontFamily: driveText.fontMeta,
    fontSize: driveText.sizeMicro,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: driveText.trackTitle,
    color: driveColors.accent,
  },
  /** The installed count, sitting off the eyebrow as an instrument reading. */
  eyebrowCount: {
    fontVariantNumeric: "tabular-nums",
    color: driveColors.textDim,
  },
  title: {
    marginTop: "0.5rem",
    fontFamily: driveText.fontDisplay,
    fontSize: { default: "2.25rem", "@media (min-width: 640px)": "3rem" },
    lineHeight: 1.05,
    fontWeight: 600,
    letterSpacing: "-0.025em",
  },
  lede: {
    marginTop: "0.5rem",
    maxWidth: "36rem",
    fontSize: "0.875rem",
    lineHeight: "1.5rem",
    color: driveColors.textMeta,
  },

  /** Every non-card state — failed, loading, empty — occupies the same slot. */
  state: {
    marginTop: "2rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.875rem",
  },
  stateError: { color: driveColors.danger },
  stateLoading: { color: driveColors.textDim },
  stateEmpty: { color: driveColors.textMeta },
  icon: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
  },
  spinner: {
    animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },

  grid: {
    marginBlock: 0,
    marginTop: "2rem",
    display: "grid",
    gap: "1rem",
    listStyle: "none",
    paddingInline: 0,
    gridTemplateColumns: {
      default: null,
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 1024px)": "repeat(3, minmax(0, 1fr))",
    },
  },

  /**
   * A map card.
   *
   * Nothing is selected on this screen — a click starts the next one — so the
   * only state a card carries is hover, and it lights the same accent edge a
   * selected row would elsewhere in Drive. `focusVisible` gets the same ring so
   * a keyboard walk through the grid reads exactly like a mouse hover.
   */
  card: {
    display: "flex",
    height: "100%",
    width: "100%",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: driveColors.lineFaint,
      ":hover": driveColors.accentBorder,
    },
    borderRadius: driveRadius.card,
    backgroundColor: {
      default: driveColors.glassCard,
      ":hover": driveColors.accentWashHover,
    },
    padding: 0,
    textAlign: "left",
    color: driveColors.textPrimary,
    cursor: "pointer",
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: "2px",
    outlineColor: driveColors.accent,
    outlineOffset: "2px",
  },
  /** The thumbnail well: a fixed 16:9 so a missing image costs no layout. */
  well: {
    position: "relative",
    display: "block",
    aspectRatio: "16 / 9",
    overflow: "hidden",
    backgroundColor: driveColors.panelWell,
  },
  thumbnail: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  wellPlaceholder: {
    display: "grid",
    width: "100%",
    height: "100%",
    placeItems: "center",
    color: driveColors.textPlaceholder,
  },
  placeholderIcon: {
    width: "2rem",
    height: "2rem",
  },

  caption: {
    display: "flex",
    flexDirection: "column",
    paddingInline: "1rem",
    paddingBlock: "0.75rem",
  },
  cardTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: driveText.fontDisplay,
    fontSize: "1rem",
    lineHeight: "1.5rem",
    fontWeight: 500,
    color: driveColors.textTitle,
  },
  /** Locality and the build this map came from — what a player checks twice. */
  cardMeta: {
    marginTop: "0.25rem",
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
  },
  locality: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    color: driveColors.textFaint,
  },
  version: {
    flexShrink: 0,
    fontFamily: driveText.fontMono,
    fontSize: driveText.sizeTag,
    textTransform: "uppercase",
    letterSpacing: driveText.trackTag,
    fontVariantNumeric: "tabular-nums",
    color: driveColors.textPlaceholder,
  },
});

/**
 * First screen: where to drive.
 *
 * Only installed maps appear — this is a game, so there is nothing to download
 * here and nothing to explain about closures. Props only; the host owns the
 * catalog fetch.
 */
export function MapPickerScreen({ maps, loading, error, onPick }: {
  maps: readonly DriveMapOption[];
  loading: boolean;
  error: string | null;
  onPick: (mapVersionId: string) => void;
}) {
  return (
    <main
      {...stylex.props(driveChrome.screen, styles.screen)}
      data-testid="drive-map-picker"
    >
      <div {...stylex.props(styles.column)}>
        <p {...stylex.props(styles.eyebrow)}>
          Drive
          {!loading && !error && maps.length > 0 ? (
            <span {...stylex.props(styles.eyebrowCount)}>
              {maps.length} installed
            </span>
          ) : null}
        </p>
        <h1 {...stylex.props(styles.title)}>Pick a map</h1>
        <p {...stylex.props(styles.lede)}>
          Installed maps only. Download more from the map gallery and they show up here.
        </p>

        {error ? (
          <p {...stylex.props(styles.state, styles.stateError)} role="alert">
            <CircleAlert {...stylex.props(styles.icon)} aria-hidden="true" />
            {error}
          </p>
        ) : loading ? (
          <p {...stylex.props(styles.state, styles.stateLoading)} role="status">
            <LoaderCircle {...stylex.props(styles.icon, styles.spinner)} aria-hidden="true" />
            Loading installed maps…
          </p>
        ) : maps.length === 0 ? (
          <p {...stylex.props(styles.state, styles.stateEmpty)} role="status">
            No maps are installed on this machine yet.
          </p>
        ) : (
          <ul {...stylex.props(styles.grid)}>
            {maps.map((map) => (
              <li key={map.mapVersionId}>
                <button
                  {...stylex.props(styles.card)}
                  data-map-version-id={map.mapVersionId}
                  data-testid="drive-map-card"
                  onClick={() => onPick(map.mapVersionId)}
                  type="button"
                >
                  <span {...stylex.props(styles.well)}>
                    {map.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- host-served thumbnail, no loader needed
                      <img {...stylex.props(styles.thumbnail)} alt="" src={map.thumbnailUrl} />
                    ) : (
                      <span {...stylex.props(styles.wellPlaceholder)}>
                        <MapPin {...stylex.props(styles.placeholderIcon)} aria-hidden="true" />
                      </span>
                    )}
                  </span>
                  <span {...stylex.props(styles.caption)}>
                    <span {...stylex.props(styles.cardTitle)}>{map.label}</span>
                    <span {...stylex.props(styles.cardMeta)}>
                      <span {...stylex.props(styles.locality)}>
                        {map.locality ?? "Unknown locality"}
                      </span>
                      <span {...stylex.props(styles.version)}>
                        {map.mapVersionId.slice(0, 8)}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
