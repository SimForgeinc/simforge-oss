import { Badge } from "./ui/badge";
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
      /**
       * `xstyle`, not `className`: Badge applies its own base and variant
       * styles, and StyleX can only merge two style sets that reach it as
       * styles. Through `className` both atom sets survive onto the element
       * and the stylesheet's order decides each property, which loses the
       * pill's padding, size and status colours to the Badge variant.
       */
      xstyle={[
        styles.root,
        size === "sm" ? styles.small : styles.medium,
        STATUS_STYLE[compatibility.status],
      ]}
    >
      <span>{CARLA_COMPATIBILITY_LABEL[compatibility.status]}</span>
    </Badge>
  );
}
