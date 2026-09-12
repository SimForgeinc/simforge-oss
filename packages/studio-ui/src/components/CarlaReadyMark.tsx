import Image from "next/image";
import * as stylex from "@stylexjs/stylex";
import { mergeStyleProps } from "./stylex/surface";
import { styles } from "./CarlaReadyMark.stylex";

/**
 * The CARLA wordmark, used as the single visual signal that an actor has a
 * measured CARLA blueprint. One definition so the timeline, the add-actor
 * panel, and anything added later cannot drift apart on asset path or sizing.
 */
export const CARLA_MARK_SRC = "/scenario-editor/carla-mark.png";

export function CarlaReadyMark({
  className,
  size = 14,
  testId,
  title,
}: {
  className?: string;
  size?: number;
  testId?: string;
  title?: string;
}) {
  return (
    <Image
      src={CARLA_MARK_SRC}
      alt=""
      aria-hidden="true"
      title={title}
      unoptimized
      width={size}
      height={size}
    />
  );
}
