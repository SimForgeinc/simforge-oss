"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./NewDatasetDialog.stylex";
import { useId } from "react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { control } from "../scenario-controls.stylex";
import { CopyableErrorMessage } from "./CopyableErrorMessage";

export function NewDatasetDialog({
  open,
  name,
  busy,
  error,
  title = "New dataset",
  description = "Give your dataset a short name. You can add scenarios after it's created.",
  placeholder = "Dataset name",
  submitLabel = "Create dataset",
  busyLabel = "Creating...",
  onNameChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  name: string;
  busy: boolean;
  error: string | null;
  title?: string;
  description?: string;
  placeholder?: string;
  submitLabel?: string;
  busyLabel?: string;
  onNameChange: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  if (!open) return null;
  return (
    <div {...stylex.props(styles.divFixedFlex)}>
      <button
        type="button"
        {...stylex.props(styles.closeNewDatasetDialogButton)}
        aria-label="Close new dataset dialog"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        {...stylex.props(styles.dialog)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} {...stylex.props(styles.h2BaseSemibold)}>
          {title}
        </h2>
        <p {...stylex.props(styles.pXs)}>{description}</p>
        <label htmlFor={nameId} {...stylex.props(styles.labelSrOnly)}>
          {placeholder}
        </label>
        <Input
          id={nameId}
          type="text"
          autoFocus
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim() && !busy) {
              onSubmit();
            } else if (event.key === "Escape" && !busy) {
              onClose();
            }
          }}
          placeholder={placeholder}
          xstyle={control.spaceAbove4}
          disabled={busy}
        />
        {/*
          The name collision is the one error worth showing in place rather than in the page banner:
          `UNIQUE (workspace_id, name)` is not partial, so a soft-deleted dataset still holds its
          name and the fix is to type a different one right here.
        */}
        {error ? <CopyableErrorMessage message={error} {...stylex.props(styles.copyableerrormessageXs)} /> : null}
        <div {...stylex.props(styles.divFlex)}>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy || !name.trim()} onClick={onSubmit}>
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
