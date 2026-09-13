"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { motionStyles } from "../../stylex/motion.stylex";
import { styles } from "./select-menu.stylex";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export type SelectMenuOption = { value: string; label?: string; disabled?: boolean };
export type SelectMenuProps = {
  value: string;
  options: readonly (SelectMenuOption | string)[];
  onChange: (value: string) => void;
  label?: string;
  labelledBy?: string;
  display?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  /**
   * Caller StyleX for the trigger, applied after the trigger's own styles so
   * the caller wins on conflicts by declaration order rather than by where
   * StyleX's equal-priority tiebreak happens to sort the atoms.
   */
  xstyle?: stylex.StyleXStyles;
  align?: "start" | "center" | "end";
  id?: string;
};

function normalize(option: SelectMenuOption | string): SelectMenuOption {
  return typeof option === "string" ? { value: option } : option;
}

export function SelectMenu({
  value, options, onChange, label, labelledBy, display, placeholder = "Select…",
  disabled, className, contentClassName, align = "start", id, xstyle,
}: SelectMenuProps) {
  const normalized = React.useMemo(() => options.map(normalize), [options]);
  const selected = normalized.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button" id={id} aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy} disabled={disabled}
          {...mergeStyleProps(stylex.props(styles.trigger, motionStyles.editorMotion, xstyle), className)}
        >
          <span {...stylex.props(styles.value)}>{display ?? selected?.label ?? selected?.value ?? placeholder}</span>
          <ChevronDown aria-hidden="true" {...stylex.props(styles.icon)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} {...mergeStyleProps(stylex.props(styles.content), contentClassName)}>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {normalized.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label ?? option.value}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SelectMenuField({
  label, labelClassName, labelXstyle, fieldClassName, fieldXstyle, ...props
}: Omit<SelectMenuProps, "label" | "labelledBy"> & {
  label: string;
  labelClassName?: string;
  labelXstyle?: stylex.StyleXStyles;
  fieldClassName?: string;
  fieldXstyle?: stylex.StyleXStyles;
}) {
  const labelId = React.useId();
  return (
    <div {...mergeStyleProps(stylex.props(styles.field, fieldXstyle), fieldClassName)}>
      <span id={labelId} {...mergeStyleProps(stylex.props(styles.fieldLabel, labelXstyle), labelClassName)}>{label}</span>
      <SelectMenu {...props} labelledBy={labelId} />
    </div>
  );
}
