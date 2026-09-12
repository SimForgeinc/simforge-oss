import * as stylex from "@stylexjs/stylex";
import { Badge } from "./ui/badge";
import { mergeStyleProps } from "./stylex/surface";
import { styles } from "./CarlaCompatibilityPill.stylex";
import {
  CARLA_COMPATIBILITY_HINT,
  CARLA_COMPATIBILITY_LABEL,
  type CarlaCompatibility,
} from "../lib/scenario/carla-compatibility";

interface CarlaCompatibilityPillProps {
  compatibility: CarlaCompatibility;
  size?: "sm" | "md";
}

const STATUS_STYLE = {
  native: styles.native,
  "generated-pack": styles.generated,
  "browser-only": styles.browser,
} as const;

export function CarlaCompatibilityPill({
  compatibility,
  size = "sm",
}: CarlaCompatibilityPillProps) {
  const detail = compatibility.status === "native"
    ? `Blueprint: ${compatibility.blueprintId}`
    : compatibility.reason;

  return (
    <Badge
      variant={compatibility.status === "browser-only" ? "outline" : "secondary"}
      data-carla-compatibility={compatibility.status}
      title={`${CARLA_COMPATIBILITY_HINT[compatibility.status]} ${detail}`}
      {...mergeStyleProps(
        stylex.props(
          styles.root,
          size === "sm" ? styles.small : styles.medium,
          STATUS_STYLE[compatibility.status],
        ),
        undefined,
      )}
    >
      <span>{CARLA_COMPATIBILITY_LABEL[compatibility.status]}</span>
    </Badge>
  );
}
