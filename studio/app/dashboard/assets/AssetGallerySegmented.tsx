"use client";

import type { LucideIcon } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import {
  mergeStyleProps,
  type XStyle,
} from "@simforge-oss/studio-ui/components/stylex";
import { segmented } from "./asset-gallery.stylex";

/**
 * The page's two either/or switches — Models vs Maps, and All vs Mine.
 *
 * Both were hand-rolled div-and-button pairs with the active class inlined at
 * each callsite, which is how they drifted apart. A radio group would be the
 * textbook control, but each option here re-fetches or re-routes the whole page
 * on activation, and radios fire on arrow-key focus: a keyboard user sweeping
 * the group would trigger every option on the way past. Buttons carrying
 * `aria-pressed` inside a labelled group announce the same state and only act
 * when actually chosen.
 */
export function AssetGallerySegmented<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
  xstyle,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; icon?: LucideIcon }[];
  onChange: (value: Value) => void;
  /** Tailwind classes from a caller that has not migrated. Applied last. */
  className?: string;
  /** Placement styles from a StyleX caller. */
  xstyle?: XStyle;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      {...mergeStyleProps(stylex.props(segmented.group, xstyle), className)}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            {...stylex.props(
              segmented.option,
              active ? segmented.optionActive : segmented.optionIdle,
            )}
          >
            {Icon ? <Icon aria-hidden="true" {...stylex.props(segmented.icon)} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
