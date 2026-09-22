"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./UserGeoJsonSection.stylex";

import { useRef, useState } from "react";
import { AlertCircle, Palette, Trash2, Upload } from "lucide-react";
import { Switch } from "@simforge-oss/studio-ui/components/ui/switch";
import {
  MAX_UPLOAD_BYTES,
  MAX_USER_GEOJSON_THICKNESS,
  MIN_USER_GEOJSON_THICKNESS,
  USER_GEOJSON_PALETTE,
  parseUserGeoJson,
  type UserGeoJsonLayer,
} from "@/app/lib/maps/frontend/user-geojson-layers";
import { hairline, motionRecipe, textLayout, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/** Props for the UserGeoJsonSection component. */
export type UserGeoJsonSectionProps = {
  layers: UserGeoJsonLayer[];
  onAddLayer: (name: string, data: object, featureCount: number) => void;
  onRemoveLayer: (id: string) => void;
  onToggleLayer: (id: string) => void;
  onSetColor: (id: string, color: string) => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onSetThickness: (id: string, thickness: number) => void;
};

/** Labelled range input + read-out, shared by the per-layer sliders. */
function SliderRow({
  label,
  ariaLabel,
  min,
  max,
  step,
  value,
  onChange,
  display,
}: {
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  display: string;
}) {
  return (
    <div {...stylex.props(styles.sliderRow)}>
      <span {...stylex.props([typography.eyebrow, styles.sliderLabel])}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        {...stylex.props(styles.sliderInput)}
        aria-label={ariaLabel}
      />
      <span {...stylex.props(styles.sliderValue)}>
        {display}
      </span>
    </div>
  );
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Upload + manage user-provided GeoJSON overlays. Rendered at the top of the
 * Layers tab so uploaded layers sit above the built-in map layers. Parsing and
 * validation happen here; the parent hook only stores validated layers.
 */
export function UserGeoJsonSection({
  layers,
  onAddLayer,
  onRemoveLayer,
  onToggleLayer,
  onSetColor,
  onSetOpacity,
  onSetThickness,
}: UserGeoJsonSectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Which layer's color palette is currently expanded (null = none).
  const [openColorId, setOpenColorId] = useState<string | null>(null);

  function handleFiles(fileList: FileList | null) {
    setError(null);
    const file = fileList?.[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `File is too large (${humanBytes(file.size)}). Maximum is ${humanBytes(MAX_UPLOAD_BYTES)}.`,
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const result = parseUserGeoJson(text);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Strip the extension for a cleaner label but keep it unique enough.
      const name = file.name.replace(/\.(geo)?json$/i, "") || file.name;
      onAddLayer(name, result.data, result.featureCount);
    };
    reader.onerror = () => setError("Could not read the file.");
    reader.readAsText(file);
  }

  return (
    <section data-testid="user-geojson-section">
      <div {...stylex.props(styles.uploadHeader)}>
        <span {...stylex.props([typography.caps, styles.uploadTitle])}>
          Uploaded GeoJSON
        </span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          {...stylex.props([motionRecipe.colors, [hairline.all, styles.uploadButton]])}
          data-testid="upload-geojson-button"
        >
          <Upload {...stylex.props(styles.uploadIcon)} />
          Upload GeoJSON
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          {...stylex.props(styles.fileInput)}
          data-testid="upload-geojson-input"
          onChange={(e) => {
            handleFiles(e.target.files);
            // Reset so re-selecting the same file re-triggers onChange.
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div
          {...stylex.props(styles.errorMessage)}
          data-testid="upload-geojson-error"
          role="alert"
        >
          <AlertCircle {...stylex.props(styles.errorIcon)} />
          <span>{error}</span>
        </div>
      )}

      {layers.length > 0 && (
        <ul {...stylex.props(styles.layerList)}>
          {layers.map((layer) => {
            const paletteOpen = openColorId === layer.id;
            return (
              <li
                key={layer.id}
                {...stylex.props([hairline.all, styles.layerItem])}
              >
                <div {...stylex.props(styles.layerControls)}>
                  <button
                    type="button"
                    onClick={() => setOpenColorId(paletteOpen ? null : layer.id)}
                    {...stylex.props(styles.colorButton)}
                    style={{ backgroundColor: layer.color }}
                    title="Change color"
                    aria-label={`Change color for ${layer.name}`}
                  >
                    <Palette {...stylex.props(styles.paletteIcon)} />
                  </button>
                  <span
                    {...stylex.props([textLayout.truncate, styles.layerName])}
                    title={layer.name}
                  >
                    {layer.name}
                  </span>
                  <span {...stylex.props(styles.featureCount)}>
                    {layer.featureCount.toLocaleString()}
                  </span>
                  <Switch
                    checked={layer.visible}
                    onCheckedChange={() => onToggleLayer(layer.id)}
                    aria-label={`Toggle ${layer.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveLayer(layer.id)}
                    {...stylex.props([motionRecipe.colors, styles.removeButton])}
                    title="Remove layer"
                    aria-label={`Remove ${layer.name}`}
                  >
                    <Trash2 {...stylex.props(styles.removeIcon)} />
                  </button>
                </div>

                {paletteOpen && (
                  <div {...stylex.props(styles.colorPalette)}>
                    {USER_GEOJSON_PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => {
                          onSetColor(layer.id, c);
                          setOpenColorId(null);
                        }}
                        {...stylex.props([motionRecipe.transform, styles.colorSwatch], layer.color === c && styles.colorSwatchSelected)}
                        style={{ backgroundColor: c }}
                        aria-label={`Set color ${c}`}
                        aria-pressed={layer.color === c}
                      />
                    ))}
                  </div>
                )}

                <SliderRow
                  label="Opacity"
                  ariaLabel={`Opacity for ${layer.name}`}
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={layer.opacity}
                  onChange={(v) => onSetOpacity(layer.id, v)}
                  display={`${Math.round(layer.opacity * 100)}%`}
                />
                <SliderRow
                  label="Thickness"
                  ariaLabel={`Thickness for ${layer.name}`}
                  min={MIN_USER_GEOJSON_THICKNESS}
                  max={MAX_USER_GEOJSON_THICKNESS}
                  step={0.25}
                  value={layer.thickness}
                  onChange={(v) => onSetThickness(layer.id, v)}
                  display={`${layer.thickness}×`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
