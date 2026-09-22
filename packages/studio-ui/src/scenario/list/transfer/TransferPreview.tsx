"use client";

import * as stylex from "@stylexjs/stylex";
import { memo } from "react";
import type { ScenarioTransferPreviewDto } from "@simforge-oss/studio-host";
import { styles } from "./TransferPreview.stylex";

/**
 * A placement drawn as a plan: the target map's lanes around the site and the
 * scenario's actors where the compiler put them, the measured actor in the
 * accent colour. The geometry arrives from the server in scene metres, so the
 * drawing is one `<svg>` with that frame as its `viewBox` — no canvas, no
 * image request, nothing to cache beyond the response that carried it.
 */

export const TransferPreview = memo(function TransferPreview({
  preview,
}: {
  preview: ScenarioTransferPreviewDto;
}) {
  const [x, y, width, height] = preview.viewBox;
  // A person is under a metre wide; below a thumbnail pixel it vanishes, so
  // people and props are drawn at a readable minimum.
  const minimum = Math.max(width, height) / 90;
  return (
    <svg
      viewBox={`${x} ${y} ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      {...stylex.props(styles.svg)}
    >
      {preview.lanes.map((lane) => (
        <path key={`${lane.kind}:${lane.width}`} d={lane.d} strokeWidth={lane.width} {...stylex.props(styles[lane.kind])} />
      ))}
      {preview.lanes.filter((lane) => lane.kind === "drive").map((lane) => (
        <path key={`line:${lane.width}`} d={lane.d} {...stylex.props(styles.laneLine)} />
      ))}
      {preview.route ? <path d={preview.route} {...stylex.props(styles.route)} /> : null}
      {preview.actors.map((actor) =>
        actor.kind === "vru" ? (
          <circle key={actor.id} cx={actor.x} cy={actor.y} r={Math.max(actor.width / 2, minimum / 2)} {...stylex.props(styles.vru)} />
        ) : (
          <rect
            key={actor.id}
            x={-Math.max(actor.length, minimum) / 2}
            y={-Math.max(actor.width, minimum) / 2}
            width={Math.max(actor.length, minimum)}
            height={Math.max(actor.width, minimum)}
            transform={`translate(${actor.x} ${actor.y}) rotate(${actor.rotateDeg})`}
            {...stylex.props(styles[actor.kind])}
          />
        ),
      )}
    </svg>
  );
});
