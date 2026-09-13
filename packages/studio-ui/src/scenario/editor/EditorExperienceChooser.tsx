"use client";

import { Clock3, SlidersHorizontal } from "lucide-react";
import type { EditorExperience } from "./simple-timed-routes";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorExperienceChooser.stylex";

export function EditorExperienceChooser({ onChoose }: { onChoose: (mode: EditorExperience) => void }) {
  return (
    <div {...stylex.props(styles.absGridCentered)} data-testid="editor-experience-chooser">
      <div {...stylex.props(styles.borderedWidePad6)}>
        <h2 {...stylex.props(styles.xlWhiteSemibold)}>How do you want to build this scenario?</h2>
        <p {...stylex.props(styles.sm)}>You can switch views later without changing the simulation format.</p>
        <div {...stylex.props(styles.gridGap3)}>
          <button {...stylex.props(styles.borderedPad4LeftText)} onClick={() => onChoose("simple")} type="button">
            <Clock3 className={stylex.props(styles.size6Text).className} />
            <strong {...stylex.props(styles.blockSmWhite)}>Simple</strong>
            <span {...stylex.props(styles.blockXs)}>Every movable actor gets one custom timed route. After its final authored point, the actor brakes under physics; the timeline stays visible but locked.</span>
          </button>
          <button {...stylex.props(styles.borderedPad4LeftText2)} onClick={() => onChoose("advanced")} type="button">
            <SlidersHorizontal className={stylex.props(styles.size6TextWhite70).className} />
            <strong {...stylex.props(styles.blockSmWhite)}>Advanced</strong>
            <span {...stylex.props(styles.blockXs)}>Use the current multi-track timeline, triggers, actions, signals, and detailed controls.</span>
          </button>
        </div>
      </div>
    </div>
  );
}
