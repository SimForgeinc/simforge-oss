"use client";

import { Clock3, MapPin, Pause, Route, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./SimpleRouteTutorialPanel.stylex";

export function SimpleRouteTutorialPanel({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: () => void;
}) {
  return (
    <div
      {...stylex.props(styles.fixedFlexCenter)}
      data-testid="simple-route-tutorial-backdrop"
    >
      <section
        aria-describedby="simple-route-tutorial-description"
        aria-labelledby="simple-route-tutorial-title"
        aria-modal="true"
        {...stylex.props(styles.whiteBorderedWide)}
        role="dialog"
      >
        <div {...stylex.props(styles.flexStartGap3)}>
          <span {...stylex.props(styles.flexCenterMid)}>
            <Route aria-hidden="true" className={stylex.props(styles.size5).className} />
          </span>
          <div {...stylex.props(styles.fillNarrowable)}>
            <p {...stylex.props(styles.capsMonoBold)}>
              Simple route
            </p>
            <h2 {...stylex.props(styles.lgSemibold)} id="simple-route-tutorial-title">
              Draw where the actor moves
            </h2>
          </div>
          <button
            aria-label="Close route tutorial"
            {...stylex.props(styles.flexCenterMid2)}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className={stylex.props(styles.size4).className} />
          </button>
        </div>

        <div {...stylex.props(styles.mt5StackLg)} id="simple-route-tutorial-description">
          <div {...stylex.props(styles.flexRuleTGap3)}>
            <Clock3 aria-hidden="true" className={stylex.props(styles.tight).className} />
            <p {...stylex.props(styles.sm)}>
              The starting position is 0 seconds. Each click appends the next point in order and represents
              <strong {...stylex.props(styles.whiteSemibold)}> one second</strong>: the first point is
              1 second, the second is 2 seconds, and so on. Press Ctrl+Z or Cmd+Z to undo the latest point.
            </p>
          </div>
          <div {...stylex.props(styles.flexRuleTGap3)}>
            <Pause aria-hidden="true" className={stylex.props(styles.tight).className} />
            <p {...stylex.props(styles.sm)}>
              Click directly on the highlighted last point again to add a
              <strong {...stylex.props(styles.whiteSemibold)}> one-second wait</strong>. The actor
              stays in place and keeps facing the same direction.
            </p>
          </div>
          <div {...stylex.props(styles.flexRuleTGap3)}>
            <MapPin aria-hidden="true" className={stylex.props(styles.tight).className} />
            <p {...stylex.props(styles.sm)}>
              If you end the path early, the actor stops at the last point and waits there
              for the rest of the scenario.
            </p>
          </div>
        </div>

        <div {...stylex.props(styles.flexCenterBetween)}>
          <p {...stylex.props(styles.capsMono)}>
            Click map to place · Enter to finish
          </p>
          <button
            autoFocus
            {...stylex.props(styles.tightCapsXs)}
            onClick={onStart}
            type="button"
          >
            Draw route
          </button>
        </div>
      </section>
    </div>
  );
}
