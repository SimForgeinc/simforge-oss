"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { RENDERING_PREFERENCE_CHOICES, type RenderingPreference } from "../components/rendering-preference";
import { styles } from "./RenderSelectionPanel.stylex";
import { hairline, textLayout } from "../stylex/recipes.stylex";

/** A device preference, not a benchmark or a render-job quality setting. */
export function RenderSelectionPanel({ currentQuality, onChoose, titleId, descriptionId, footer }: {
  currentQuality: RenderingPreference;
  onChoose: (preference: RenderingPreference) => void;
  titleId?: string;
  descriptionId?: string;
  footer?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.content)} data-testid="render-selection-content">
        <header {...stylex.props(styles.header)}>
          <h2 id={titleId} {...stylex.props(styles.title)}>Render settings</h2>
          <p id={descriptionId} {...stylex.props([textLayout.truncate, styles.lede])} title="The initial setting follows this device’s GPU capabilities. Texture targets may be reduced by the viewer when memory or format support is limited. Render jobs have their own quality settings.">
            Graphics for this device. Change any time.
          </p>
        </header>
        <div {...stylex.props(styles.choices, footer != null && styles.withCache)}>
          {RENDERING_PREFERENCE_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              onClick={() => onChoose(choice.id)}
              aria-label={`Use ${choice.label}`}
              aria-pressed={choice.id === currentQuality}
              title={choice.description}
              {...stylex.props([hairline.all, hairline.strong, styles.choice], choice.id === currentQuality && styles.choiceCurrent)}
            >
              <span {...stylex.props(styles.choiceLabel)}>{choice.label}</span>
              <span {...stylex.props(styles.choiceCopy)}>{choice.description}</span>
              <span {...stylex.props(styles.choiceTag)}>{choice.id === currentQuality ? "Current" : "Select"}</span>
            </button>
          ))}
          {footer != null ? <div {...stylex.props([hairline.all, hairline.strong, styles.cache])}>{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}
