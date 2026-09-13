"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import {
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  type ScenarioAuthoringQuality,
} from "../../../lib/scenario/contracts";
import type { ScenarioMapEntry } from "@simforge-oss/editor";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorStatePanels.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

const QUALITY_PREVIEW_IMAGES: Record<ScenarioAuthoringQuality, string> = {
  "roads-only": "/render-selection/roads-only.jpg",
  "ultra-low-3d": "/render-selection/ultra-low.jpg",
  minimal: "/render-selection/minimal.jpg",
  high: "/render-selection/high.jpg",
};

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

/**
 * Choice of streaming budget, the Settings surface for it. First-run setup has
 * its own screens (`onboarding/MapSelectionScreen`); this one is reachable any
 * time and never redirects anywhere.
 */
export function QualityChooser({
  onChoose,
  titleId,
  descriptionId,
  benchmark,
  footer,
}: {
  onChoose: (quality: ScenarioAuthoringQuality) => void;
  titleId?: string;
  descriptionId?: string;
  benchmark?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.gridCentered)}>
      <div
        {...stylex.props(styles.whiteWide)}
        data-testid="render-selection-content"
        data-visual-treatment="flat"
      >
        <div {...stylex.props(styles.centerText)}>
          <p {...stylex.props(styles.capsMetaBold)}>
            Rendering
          </p>
          <h1
            id={titleId}
            {...stylex.props(styles.xxxlWhiteSemibold)}
          >
            Render Selection
          </h1>
          <p id={descriptionId} {...stylex.props(styles.sm)}>
            Find the best experience for this device. You can change this any time.
          </p>
        </div>
        {benchmark}
        <div {...stylex.props(styles.flexCenterGap4)}>
          <div {...stylex.props(styles.fill)} />
          <h2 {...stylex.props(styles.capsMetaBold2)}>
            Manual Selection
          </h2>
          <div {...stylex.props(styles.fill)} />
        </div>
        <div {...stylex.props(styles.gridCols4Gap2)}>
          {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              onClick={() => onChoose(choice.id)}
              aria-label={`Use ${choice.label}`}
              className={`${stylex.props(styles.leftText, motionStyles.editorMotion).className} group`}
            >
              <span
                aria-hidden="true"
                {...stylex.props(styles.relBlockClip)}
              >
                <span
                  className={`${stylex.props(styles.absInset0).className} group-hover:scale-[1.04]`}
                  style={{
                    backgroundImage: `url(${QUALITY_PREVIEW_IMAGES[choice.id]})`,
                  }}
                />
                <span {...stylex.props(styles.absInset02)} />
                <span {...stylex.props(styles.absCapsMeta)}>
                  Belmont · same camera
                </span>
              </span>
              <span {...stylex.props(styles.block)}>
                <span {...stylex.props(styles.flexCenter)}>
                  <span {...stylex.props(styles.whiteSemibold)}>
                    {choice.label}
                  </span>
                  {choice.recommended ? (
                    <span {...stylex.props(styles.capsBoldPushRight)}>
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span {...stylex.props(styles.blockXs)}>
                  {choice.id === "roads-only"
                    ? "Core roads and traffic, without 3D scenery"
                    : choice.id === "ultra-low-3d"
                      ? "Lightweight 3D for lower-powered devices"
                      : choice.id === "minimal"
                        ? "Recommended for most devices"
                        : "Highest detail for powerful devices"}
                </span>
              </span>
            </button>
          ))}
        </div>
        {footer ? (
          <div {...stylex.props(styles.ruleT)}>{footer}</div>
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
