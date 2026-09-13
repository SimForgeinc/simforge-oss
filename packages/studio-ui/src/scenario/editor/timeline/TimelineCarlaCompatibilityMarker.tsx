import { CarlaReadyMark } from "../../../components/CarlaReadyMark";
import {
  CARLA_COMPATIBILITY_LABEL,
  type CarlaCompatibility,
} from "../../../lib/scenario/carla-compatibility";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./TimelineCarlaCompatibilityMarker.stylex";

const UNAVAILABLE_DOT_STYLE: Record<
  Exclude<CarlaCompatibility["status"], "native">,
  stylex.StyleXStyles
> = {
  "generated-pack": styles.dotGeneratedPack,
  "browser-only": styles.dotBrowserOnly,
};

/**
 * Per-actor CARLA readiness marker in the timeline identity column.
 *
 * CARLA-ready actors show the CARLA logo; this is the only CARLA-ready
 * indication in the editor, so the details panel deliberately shows none.
 * Actors that cannot render in CARLA keep a muted status dot.
 */
export function TimelineCarlaCompatibilityMarker({
  actorLabel,
  compatibility,
}: {
  actorLabel: string;
  compatibility: CarlaCompatibility;
}) {
  const label = CARLA_COMPATIBILITY_LABEL[compatibility.status];
  const detail = compatibility.status === "native"
    ? compatibility.blueprintId
    : compatibility.reason;
  return (
    <span
      aria-label={`${actorLabel}: ${label}`}
      {...stylex.props(styles.inlineFlexCenterMid)}
      data-carla-compatibility={compatibility.status}
      role="img"
      title={`${label}: ${detail}`}
    >
      {compatibility.status === "native" ? (
        <CarlaReadyMark xstyle={styles.size35} testId="timeline-carla-ready-logo" />
      ) : (
        <span
          aria-hidden="true"
          {...stylex.props(styles.round, UNAVAILABLE_DOT_STYLE[compatibility.status])}
        />
      )}
    </span>
  );
}
