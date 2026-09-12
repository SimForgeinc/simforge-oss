"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
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
  align?: "start" | "center" | "end";
  id?: string;
};

function normalize(option: SelectMenuOption | string): SelectMenuOption {
  return typeof option === "string" ? { value: option } : option;
}

export function SelectMenu({
  value, options, onChange, label, labelledBy, display, placeholder = "Select…",
  disabled, className, contentClassName, align = "start", id,
}: SelectMenuProps) {
  const normalized = React.useMemo(() => options.map(normalize), [options]);
  const selected = normalized.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button" id={id} aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy} disabled={disabled}
          {...mergeStyleProps(stylex.props(styles.trigger), className ? `editor-motion ${className}` : "editor-motion")}
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
  label, labelClassName, fieldClassName, ...props
}: Omit<SelectMenuProps, "label" | "labelledBy"> & {
  label: string;
  labelClassName?: string;
  fieldClassName?: string;
}) {
  const labelId = React.useId();
  return (
    <div {...mergeStyleProps(stylex.props(styles.field), fieldClassName)}>
      <span id={labelId} {...mergeStyleProps(stylex.props(styles.fieldLabel), labelClassName)}>{label}</span>
      <SelectMenu {...props} labelledBy={labelId} />
    </div>
  );
}
