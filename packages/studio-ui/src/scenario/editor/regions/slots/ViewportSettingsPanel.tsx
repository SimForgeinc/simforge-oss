"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { RotateCcw, Settings2, X } from "lucide-react";
import type { CityViewer } from "@simforge-oss/viewer";
import {
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  type ScenarioAuthoringQuality,
} from "../../../../lib/scenario/contracts";
import type { CameraControlPreferences } from "@simforge-oss/viewer";
import { Button } from "../../../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "../../../../components/ui/sheet";
import type { EditorExperience } from "../../simple-timed-routes";
import { CopyDebugInformationButton } from "../CopyDebugInformationButton";
import {
  DEFAULT_VIEWPORT_SETTINGS,
  isDefaultViewportSettings,
  LOOK_SENSITIVITY_RANGE,
  loadViewportSettings,
  SENSITIVITY_RANGE,
  saveViewportSettings,
  type ViewportLayerKey,
  type ViewportSettings,
} from "./viewport-settings";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ViewportSettingsPanel.stylex";

/**
 * Editor, viewport, and camera settings for either the editor top bar or the idle canvas.
 *
 * Collapsed to a single button by default. This sits over the scene, and a permanently open 300px panel
 * would cover the part of the map most people orbit around.
 *
 * Everything here writes straight through to the live viewer — there is no Apply button. Tuning a look
 * sensitivity is a feel judgement: you find the right value by moving the slider and dragging the scene,
 * which is impossible if the value only lands on confirm.
 */
export function ViewportSettingsPanel({
  viewer,
  quality,
  onQualityChange,
  placement = "canvas",
  experience = null,
  onExperienceToggle,
  getDebugInformation,
}: {
  viewer: CityViewer | null;
  quality?: ScenarioAuthoringQuality;
  onQualityChange?: (quality: ScenarioAuthoringQuality) => void;
  placement?: "canvas" | "topbar";
  experience?: EditorExperience | null;
  onExperienceToggle?: () => void;
  getDebugInformation?: () => string;
}) {
  const [open, setOpen] = useState(false);
  // Read from storage lazily so the first render already has the user's own settings and the camera never
  // briefly runs on defaults.
  const [settings, setSettings] = useState<ViewportSettings>(() => loadViewportSettings());
  const panelId = useId();

  const update = useCallback((next: ViewportSettings) => {
    setSettings(next);
    saveViewportSettings(next);
  }, []);

  const setControls = useCallback(
    (patch: Partial<CameraControlPreferences>) =>
      update({ ...settings, controls: { ...settings.controls, ...patch } }),
    [settings, update],
  );

  // Push the whole state at the viewer whenever either changes. Keyed on `viewer` as well as `settings`
  // because the viewer arrives after first paint, and is replaced whenever the quality preset remounts
  // it — a one-shot apply would silently revert to defaults on both.
  useEffect(() => {
    if (!viewer) return;
    viewer.setCameraControlPreferences(settings.controls);
    viewer.setCameraMode(settings.cameraMode);
    for (const [layer, visible] of Object.entries(settings.layers)) {
      viewer.setLayerVisible(layer as ViewportLayerKey, visible);
    }
  }, [viewer, settings]);

  const modified = !isDefaultViewportSettings(settings);

  const trigger = (
    <Button
      type="button"
      size={placement === "topbar" ? "sm" : "icon"}
      variant="outline"
      xstyle={placement === "topbar" ? styles.glassyGap2 : styles.glassy}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={placement === "topbar" ? "Settings" : "Viewport and camera settings"}
      title="Viewport and camera settings"
      onClick={placement === "canvas" ? () => setOpen((value) => !value) : undefined}
    >
      <Settings2 className={stylex.props(styles.size4).className} aria-hidden="true" />
      {placement === "topbar" ? <span>Settings</span> : null}
    </Button>
  );

  if (!open && placement === "canvas") {
    return <div {...stylex.props(styles.abs)}>{trigger}</div>;
  }

  const panel = (
    <div
      id={panelId}
      {...stylex.props(placement === "topbar" ? styles.flexColFill : styles.absFlexCol)}
      role="group"
      aria-label="Viewport and camera settings"
    >
      <div {...stylex.props(styles.flexCenterBetween)}>
        <span {...stylex.props(styles.capsMetaMicro)}>
          Settings
        </span>
        <div {...stylex.props(styles.flexCenterGap05)}>
          {modified ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              xstyle={styles.size6}
              aria-label="Reset all viewport settings to defaults"
              title="Reset to defaults"
              onClick={() => update({ ...DEFAULT_VIEWPORT_SETTINGS })}
            >
              <RotateCcw className={stylex.props(styles.size3).className} aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            xstyle={styles.size6}
            aria-expanded
            aria-label="Close viewport settings"
            onClick={() => setOpen(false)}
          >
            <X className={stylex.props(styles.size3).className} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div {...stylex.props(styles.fillScrollYShrinkable)}>
        {experience && onExperienceToggle ? (
          <Section label="Editor mode">
            <Toggle
              checked={experience === "simple"}
              label="Simple mode"
              onChange={onExperienceToggle}
            />
            <p {...stylex.props(styles.microMutedSnug)}>
              Simple mode keeps the workspace focused. Weather and scene time stay available; turn
              it off for traffic and reasoning controls.
            </p>
          </Section>
        ) : null}
        {quality && onQualityChange ? (
          <Section label="Render quality">
            <div {...stylex.props(styles.gridCols2Gap1)}>
              {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => (
                <button
                  aria-pressed={quality === choice.id}
                  {...stylex.props(quality === choice.id ? styles.capsMetaInk : styles.capsMetaMuted)}
                  key={choice.id}
                  onClick={() => onQualityChange(choice.id)}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p {...stylex.props(styles.microMutedSnug)}>
              Balanced is recommended for most devices. High uses more graphics memory.
            </p>
          </Section>
        ) : null}
        <Section label="Camera mode">
          <div {...stylex.props(styles.gridCols2Gap1)}>
            {(["orbit", "fly"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={settings.cameraMode === mode}
                onClick={() => update({ ...settings, cameraMode: mode })}
                {...stylex.props(settings.cameraMode === mode ? styles.capsMetaMicro3 : styles.capsMetaMicro4)}
              >
                {mode}
              </button>
            ))}
          </div>
          <p {...stylex.props(styles.microMutedSnug)}>
            {settings.cameraMode === "orbit"
              ? "Drag orbits · middle or right drag pans · wheel zooms · WASD pans · Q/E rotates."
              : "Pointer-lock mouse look · WASD moves · Q/E rolls."}
          </p>
        </Section>

        <Section label="Invert">
          <Toggle
            label="Horizontal look"
            checked={settings.controls.reverseHorizontalLook}
            onChange={(value) => setControls({ reverseHorizontalLook: value })}
          />
          <Toggle
            label="Vertical look"
            checked={settings.controls.reverseVerticalLook}
            onChange={(value) => setControls({ reverseVerticalLook: value })}
          />
          <Toggle
            label="Horizontal pan"
            checked={settings.controls.reverseHorizontalPan}
            onChange={(value) => setControls({ reverseHorizontalPan: value })}
          />
          <Toggle
            label="Vertical pan"
            checked={settings.controls.reverseVerticalPan}
            onChange={(value) => setControls({ reverseVerticalPan: value })}
          />
        </Section>

        <Section label="Sensitivity">
          <Slider
            label="Look X"
            value={settings.controls.horizontalLookSensitivity}
            range={LOOK_SENSITIVITY_RANGE}
            onChange={(value) => setControls({ horizontalLookSensitivity: value })}
          />
          <Slider
            label="Look Y"
            value={settings.controls.verticalLookSensitivity}
            range={LOOK_SENSITIVITY_RANGE}
            onChange={(value) => setControls({ verticalLookSensitivity: value })}
          />
          <Slider
            label="Pan (middle)"
            value={settings.controls.middlePanSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ middlePanSensitivity: value })}
          />
          <Slider
            label="Pan (right)"
            value={settings.controls.rightPanSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ rightPanSensitivity: value })}
          />
          <Slider
            label="Wheel zoom"
            value={settings.controls.wheelZoomSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ wheelZoomSensitivity: value })}
          />
          <Slider
            label="Keyboard move"
            value={settings.controls.keyboardMoveSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ keyboardMoveSensitivity: value })}
          />
          <Slider
            label="Keyboard turn"
            value={settings.controls.keyboardTurnSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ keyboardTurnSensitivity: value })}
          />
        </Section>

        <Section label="Layers" last={!getDebugInformation}>
          <Toggle
            label="Buildings"
            checked={settings.layers.city}
            onChange={(value) => update({ ...settings, layers: { ...settings.layers, city: value } })}
          />
          <Toggle
            label="Vegetation"
            checked={settings.layers.vegetation}
            onChange={(value) =>
              update({ ...settings, layers: { ...settings.layers, vegetation: value } })
            }
          />
          <Toggle
            label="Roads"
            checked={settings.layers.road}
            onChange={(value) => update({ ...settings, layers: { ...settings.layers, road: value } })}
          />
          <p {...stylex.props(styles.microMutedSnug)}>
            The quality preset can hide buildings and vegetation regardless of these.
          </p>
        </Section>
        {getDebugInformation ? (
          <Section label="Support" last>
            <CopyDebugInformationButton
              xstyle={styles.startWide}
              getDebugInformation={getDebugInformation}
            />
            <p {...stylex.props(styles.microMutedSnug)}>
              Copies scenario and editor diagnostics for troubleshooting.
            </p>
          </Section>
        ) : null}
      </div>
    </div>
  );

  return placement === "topbar" ? (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        // `[&>button:last-child]:hidden` hides the close button `SheetContent`
        // renders for itself (sheet.tsx). It is a residual because it selects a
        // child this element does not render, so the declaration has nowhere
        // else to go: StyleX only styles the element it is applied to.
        xstyle={styles.flexColClip} className="[&>button:last-child]:hidden"
        data-testid="viewport-settings-drawer"
        side="right"
      >
        <SheetTitle xstyle={styles.srOnly}>Editor settings</SheetTitle>
        <SheetDescription xstyle={styles.srOnly}>
          Configure the editor mode, rendering quality, camera controls, and visible map layers.
        </SheetDescription>
        {panel}
      </SheetContent>
    </Sheet>
  ) : panel;
}

function Section({
  label,
  children,
  last = false,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section {...stylex.props(!last ? styles.ruleB : styles.pb3)}>
      <h3 {...stylex.props(styles.capsMetaMicro2)}>
        {label}
      </h3>
      {children}
    </section>
  );
}

/** A compact switch row. `role="switch"` so its on/off state is announced, not just its name. */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      {...stylex.props(styles.flexCenterBetween2)}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        {...stylex.props(checked ? styles.relTightBordered : styles.relTightBordered2)}
      >
        <span
          {...stylex.props(checked ? styles.abs2 : styles.abs3)}
        />
      </span>
    </button>
  );
}

function Slider({
  label,
  value,
  range,
  onChange,
}: {
  label: string;
  value: number;
  range: { readonly min: number; readonly max: number };
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div {...stylex.props(styles.py1)}>
      <div {...stylex.props(styles.flexBetweenBaseline)}>
        <label htmlFor={id} {...stylex.props(styles.metaMuted)}>
          {label}
        </label>
        <span {...stylex.props(styles.metaMicroNums)}>{value}%</span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={5}
        value={value}
        // Percent, not the raw number, or a screen reader announces "100" with no unit and no sense of
        // whether that is fast or slow.
        aria-valuetext={`${value} percent`}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        {...stylex.props(styles.widePointer)}
      />
    </div>
  );
}
