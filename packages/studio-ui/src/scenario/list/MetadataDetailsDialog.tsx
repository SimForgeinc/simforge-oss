"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./MetadataDetailsDialog.stylex";
import { useId } from "react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { control } from "../scenario-controls.stylex";
import { CopyableErrorMessage } from "./CopyableErrorMessage";
import { focus, hairline, typography } from "../../stylex/recipes.stylex";

/**
 * The name + description editor, shared by datasets and documents.
 *
 * v1's raw `<input>`/`<textarea>` are an `<Input>` primitive and a token-styled textarea here, which
 * is what restores the `focus-visible` ring; the labels are `htmlFor`-bound rather than wrapping,
 * because the textarea has no primitive and a wrapping label around it announced nothing.
 */
export function MetadataDetailsDialog({
  open,
  title,
  intro,
  name,
  description,
  busy,
  error,
  nameLabel = "Name",
  namePlaceholder = "Name",
  descriptionLabel = "Description",
  descriptionPlaceholder = "Description",
  submitLabel = "Save details",
  busyLabel = "Saving...",
  onNameChange,
  onDescriptionChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  intro: string;
  name: string;
  description: string;
  busy: boolean;
  error: string | null;
  nameLabel?: string;
  namePlaceholder?: string;
  descriptionLabel?: string;
  descriptionPlaceholder?: string;
  submitLabel?: string;
  busyLabel?: string;
  onNameChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const descriptionId = useId();
  if (!open) return null;
  const canSubmit = Boolean(name.trim()) && !busy;

  return (
    <div {...stylex.props(styles.divFixedFlex)}>
      <button
        type="button"
        {...stylex.props(styles.closeButton)}
        aria-label={`Close ${title}`}
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        {...stylex.props([hairline.all, styles.dialog])}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} {...stylex.props(styles.h2BaseSemibold)}>
          {title}
        </h2>
        <p {...stylex.props(styles.pXs)}>{intro}</p>
        <label
          htmlFor={nameId}
          {...stylex.props([typography.eyebrow, styles.labelMetaMicroUppercase])}
        >
          {nameLabel}
        </label>
        <Input
          id={nameId}
          type="text"
          autoFocus
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) {
              event.preventDefault();
              onSubmit();
            } else if (event.key === "Escape" && !busy) {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder={namePlaceholder}
          xstyle={control.spaceAbove15}
          disabled={busy}
        />
        <label
          htmlFor={descriptionId}
          {...stylex.props([typography.eyebrow, styles.labelMetaMicroUppercase2])}
        >
          {descriptionLabel}
        </label>
        <textarea
          id={descriptionId}
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder={descriptionPlaceholder}
          {...stylex.props([focus.ring, styles.textareaSm])}
          disabled={busy}
        />
        {error ? <CopyableErrorMessage message={error} {...stylex.props(styles.copyableerrormessageXs)} /> : null}
        <div {...stylex.props(styles.divFlex)}>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} onClick={onSubmit}>
            {busy ? (
              <CloudActivityIndicator label={busyLabel} />
            ) : (
              submitLabel
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
