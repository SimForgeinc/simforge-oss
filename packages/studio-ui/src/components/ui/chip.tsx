import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { focus, interactive, textLayout, typography } from "../../stylex/recipes.stylex";
import { colors, space, stroke } from "../../stylex/tokens.stylex";
import { type PlacementStyle, type Tone } from "../stylex/surface";

export type ChipSize = "sm" | "md";

type ChipOwnProps = {
  tone?: Tone;
  size?: ChipSize;
  /** A leading icon or `Dot`. */
  leading?: React.ReactNode;
  xstyle?: PlacementStyle;
};

export type ChipProps = ChipOwnProps & Omit<React.HTMLAttributes<HTMLSpanElement>, "className" | "style">;

/**
 * Chip: a small label for a count, a tag or a state, in the instrument face.
 * `tone` picks the colour from the status ladder; `neutral` is a plain fill.
 * For a clickable chip (a filter, a toggle) use `ChipButton`.
 *
 *   <Chip tone="positive" leading={<Dot tone="positive" />}>Ready</Chip>
 */
export function Chip({ tone = "neutral", size = "sm", leading, xstyle, children, ...props }: ChipProps) {
  return (
    <span {...stylex.props(typography.eyebrow, styles.root, sizes[size], tones[tone], xstyle)} {...props}>
      {leading}
      <span {...stylex.props(textLayout.truncate)}>{children}</span>
    </span>
  );
}

export type ChipButtonProps = ChipOwnProps & {
  /** Selected/on state; renders `aria-pressed`. */
  selected?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style">;

/** A chip that toggles or filters: the same look with a pressed state. */
export const ChipButton = React.forwardRef<HTMLButtonElement, ChipButtonProps>(
  ({ tone = "neutral", size = "sm", leading, selected = false, xstyle, type = "button", children, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      {...stylex.props(focus.ring, interactive.base, typography.eyebrow, styles.root, sizes[size], tones[tone], styles.button, selected && styles.selected, xstyle)}
      {...props}
    >
      {leading}
      <span {...stylex.props(textLayout.truncate)}>{children}</span>
    </button>
  ),
);
ChipButton.displayName = "ChipButton";

const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
    maxWidth: "100%",
    borderStyle: "solid",
    borderWidth: stroke.hairline,
  },
  button: {
    color: { default: colors.inkMuted, ":hover": colors.ink },
    borderColor: { default: colors.hairline, ":hover": colors.hairlineStrong },
  },
  selected: {
    color: colors.accent,
    backgroundColor: colors.accentWash,
    borderColor: colors.accentLineSubtle,
  },
});

const sizes = stylex.create({
  sm: { height: "1.25rem", paddingInline: space.s1_5 },
  md: { height: "1.5rem", paddingInline: space.s2 },
});

const tones = stylex.create({
  neutral: { color: colors.inkSecondary, backgroundColor: colors.fillSubtle, borderColor: colors.hairline },
  muted: { color: colors.inkMuted, backgroundColor: "transparent", borderColor: colors.hairline },
  accent: { color: colors.accent, backgroundColor: colors.accentWash, borderColor: colors.accentLineSubtle },
  positive: { color: colors.positive, backgroundColor: colors.positiveWash, borderColor: "transparent" },
  warning: { color: colors.warning, backgroundColor: colors.warningWash, borderColor: "transparent" },
  critical: { color: colors.critical, backgroundColor: colors.criticalWash, borderColor: "transparent" },
});
