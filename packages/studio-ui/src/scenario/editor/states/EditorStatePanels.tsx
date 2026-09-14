"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import type { ScenarioMapEntry } from "@simforge-oss/editor";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorStatePanels.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * The full-page panels that are genuine *content*, not boot states.
 *
 * The distinction matters and it is the one v2 got wrong. "Loading maps" and
 * "the document request failed" are transient conditions: they belong in the
 * status stream and paint through `ScenarioBootGate` as an overlay, so the
 * editor beneath them is never unmounted. What is left here is a real choice or
 * a real dead end — pick a quality, pick a map, this workspace has no maps —
 * where there is nothing to overlay because there is nothing to author yet.
 */
export function EditorEmptyState({
  title,
  detail,
  href,
  action,
}: {
  title: string;
  detail: string;
  href?: string;
  action?: string;
}) {
  return (
    <div
      aria-live="polite"
      {...stylex.props(styles.gridCenteredTall)}
      role="status"
    >
      <div {...stylex.props(styles.borderedPad8CenterText)}>
        <div
          aria-hidden="true"
          {...stylex.props(styles.gridCenteredBold)}
        >
          U2
        </div>
        <h1 {...stylex.props(styles.xlSemibold)}>{title}</h1>
        <p {...stylex.props(styles.smMuted)}>{detail}</p>
        {href && action ? (
          <Button asChild xstyle={styles.mt6}>
            <Link href={href}>{action}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Map choice for a new, unbound scenario. Once chosen, the draft follows new
 * compatible immutable builds of that same source map during release activation. */
export function MapChooser({
  maps,
  onChoose,
}: {
  maps: ScenarioMapEntry[];
  onChoose: (mapId: string) => void;
}) {
  return (
    <div {...stylex.props(styles.gridCenteredPad8)}>
      <div {...stylex.props(styles.wide)}>
        <div {...stylex.props(styles.centerText)}>
          <p {...stylex.props(styles.capsXsAccent)}>
            Map-bound scenario
          </p>
          <h1 {...stylex.props(styles.xxlSemibold)}>Choose a map</h1>
          <p {...stylex.props(styles.smMuted2)}>
            This scenario will follow compatible new builds of the selected map.
            Choosing a different map creates a separate scenario.
          </p>
        </div>
        <div {...stylex.props(styles.gridGap3)}>
          {maps.map((map) => (
            <button
              key={map.versionId}
              type="button"
              onClick={() => onChoose(map.versionId)}
              className={stylex.props(styles.borderedPad5LeftText, motionStyles.editorMotion).className}
            >
              <span {...stylex.props(styles.blockSemibold)}>{map.label}</span>
              <span {...stylex.props(styles.blockXsMuted)}>
                {map.locality || "Immutable map version"}
              </span>
              <span {...stylex.props(styles.blockMonoMicro)}>
                {map.versionId}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
