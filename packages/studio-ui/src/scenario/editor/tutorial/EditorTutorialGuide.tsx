"use client";

import {
  BookOpen,
  Box,
  Camera,
  CarFront,
  FileInput,
  Gauge,
  MousePointer2,
  Play,
  Route,
  SlidersHorizontal,
  Sparkles,
  Timer,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../components/ui/button";
import { startInteractiveTutorial } from "./interactive-tutorial-events";
import type { EditorExperience } from "../simple-timed-routes";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./EditorTutorialGuide.stylex";

const GUIDE_SECTIONS = [
  { href: "#tutorial-controls", label: "Controls" },
  { href: "#tutorial-viewport", label: "Settings" },
  { href: "#tutorial-actors", label: "Actors" },
  { href: "#tutorial-timeline", label: "Timeline" },
  { href: "#tutorial-simulation", label: "Simulation" },
  { href: "#tutorial-imports", label: "Imports" },
] as const;

const CONTROL_ITEMS = [
  {
    keys: ["Esc"],
    title: "Cancel or reset",
    body: "Cancel the current placement or edit. During simulation, stop, rewind, and return to authoring.",
  },
  {
    keys: ["Space"],
    title: "Play or pause",
    body: "Start or pause the timeline whenever you are not typing in a field.",
  },
  {
    keys: ["W", "A", "S", "D"],
    title: "Move across the map",
    body: "Pan the viewport forward, left, backward, and right.",
  },
] as const;

const POINTER_ITEMS = [
  {
    title: "Click",
    body: "Select an actor, interaction, or traffic light to open its details.",
  },
  {
    title: "Left-drag",
    body: "Orbit the camera around the current view target.",
  },
  {
    title: "Middle/right-drag · Wheel",
    body: "Pan the camera with a drag and zoom with the wheel.",
  },
] as const;

export function EditorTutorialGuide({
  experience = "advanced",
}: {
  experience?: EditorExperience;
}) {
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [guideMode, setGuideMode] = useState<EditorExperience>(experience);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const guidedButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setGuideMode(experience), [experience]);

  useEffect(() => {
    if (!choiceOpen && !open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (choiceOpen) guidedButtonRef.current?.focus();
    else closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (choiceOpen) setChoiceOpen(false);
      else setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [choiceOpen, open]);

  return (
    <>
      <Button
        aria-label="Tutorial"
        xstyle={styles.borderedGlassyGap2}
        onClick={() => setChoiceOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <BookOpen aria-hidden="true" className={stylex.props(styles.size4).className} />
        <span>Tutorial</span>
      </Button>
      {choiceOpen
        ? createPortal(
            <div
              {...stylex.props(styles.fixedGridCentered)}
              data-testid="tutorial-format-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setChoiceOpen(false);
              }}
            >
              <section
                aria-describedby="tutorial-format-description"
                aria-labelledby="tutorial-format-title"
                aria-modal="true"
                {...stylex.props(styles.whiteBorderedWide)}
                role="dialog"
              >
                <div {...stylex.props(styles.flexStartGap3)}>
                  <div {...stylex.props(styles.fillNarrowable)}>
                    <p {...stylex.props(styles.capsMonoBold)}>
                      {experience} mode
                    </p>
                    <h2 {...stylex.props(styles.lgSemibold)} id="tutorial-format-title">
                      How would you like to learn?
                    </h2>
                    <p {...stylex.props(styles.xs)} id="tutorial-format-description">
                      Follow the live editor step by step, or browse the complete written reference.
                    </p>
                  </div>
                  <button
                    aria-label="Close tutorial options"
                    {...stylex.props(styles.gridCenteredTight)}
                    onClick={() => setChoiceOpen(false)}
                    type="button"
                  >
                    <X aria-hidden="true" className={stylex.props(styles.size4).className} />
                  </button>
                </div>

                <div {...stylex.props(styles.gridGap3)}>
                  <button
                    aria-label="Start guided tutorial"
                    {...stylex.props(styles.borderedPad4LeftText)}
                    onClick={() => {
                      setChoiceOpen(false);
                      startInteractiveTutorial(experience);
                    }}
                    ref={guidedButtonRef}
                    type="button"
                  >
                    <Sparkles aria-hidden="true" className={stylex.props(styles.size5Text).className} />
                    <strong {...stylex.props(styles.blockSmWhite)}>Guided tutorial</strong>
                    <span {...stylex.props(styles.blockXs)}>
                      Complete actions in the live editor. This walkthrough authors content in the current scenario.
                    </span>
                  </button>
                  <button
                    aria-label="Open written guide"
                    {...stylex.props(styles.borderedPad4LeftText2)}
                    onClick={() => {
                      setChoiceOpen(false);
                      setGuideMode(experience);
                      setOpen(true);
                    }}
                    type="button"
                  >
                    <BookOpen aria-hidden="true" className={stylex.props(styles.size5TextWhite70).className} />
                    <strong {...stylex.props(styles.blockSmWhite)}>Written guide</strong>
                    <span {...stylex.props(styles.blockXs)}>
                      Review controls and authoring concepts without changing the current scenario.
                    </span>
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
      {open
        ? createPortal(
            <div
              {...stylex.props(styles.fixedInset0Pad3)}
              data-testid="editor-tutorial-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
                aria-describedby="editor-tutorial-description"
                aria-labelledby="editor-tutorial-title"
                aria-modal="true"
                {...stylex.props(styles.flexColInk)}
                data-testid="editor-tutorial-guide"
                role="dialog"
              >
              <header {...stylex.props(styles.flexCenterTight)}>
                <BookOpen aria-hidden="true" className={stylex.props(styles.accent).className} />
                <div {...stylex.props(styles.narrowable)}>
                  <h2 {...stylex.props(styles.semiboldBase)} id="editor-tutorial-title">
                    Editor tutorial · {guideMode === "simple" ? "Simple" : "Advanced"}
                  </h2>
                  <p {...stylex.props(styles.xsMutedTruncate)} id="editor-tutorial-description">
                    {guideMode === "simple"
                      ? "Place actors, draw timed routes, and preview the result."
                      : "Configure actors, interactions, triggers, and simulation behavior."}
                  </p>
                </div>
                <nav aria-label="Tutorial sections" {...stylex.props(styles.hiddenCenterPushRight)}>
                  {GUIDE_SECTIONS.map((section) => (
                    <a
                      {...stylex.props(styles.xsMuted)}
                      href={section.href}
                      key={section.href}
                    >
                      {section.label}
                    </a>
                  ))}
                </nav>
                <div {...stylex.props(styles.hiddenTightBordered)} role="group" aria-label="Tutorial mode">
                  {(["simple", "advanced"] as const).map((mode) => (
                    <button
                      aria-pressed={guideMode === mode}
                      {...stylex.props(styles.modeToggle, guideMode === mode ? styles.modeToggleActive : styles.modeToggleIdle)}
                      key={mode}
                      onClick={() => setGuideMode(mode)}
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <Button
                  aria-label={`Start ${guideMode} interactive tutorial`}
                  xstyle={styles.tightPushRightGap2}
                  disabled={guideMode !== experience}
                  onClick={() => {
                    setOpen(false);
                    startInteractiveTutorial(guideMode);
                  }}
                  size="sm"
                  title={guideMode === experience
                    ? `Start the ${guideMode} walkthrough in this scenario`
                    : `Switch the editor to ${guideMode} mode in Settings before starting`}
                  type="button"
                >
                  <Sparkles aria-hidden="true" className={stylex.props(styles.size35).className} />
                  <span {...stylex.props(styles.hidden)}>Start {guideMode} tutorial</span>
                </Button>
                <Button
                  aria-label="Close tutorial"
                  xstyle={styles.tightPushRight}
                  onClick={() => setOpen(false)}
                  ref={closeButtonRef}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" className={stylex.props(styles.size4).className} />
                </Button>
              </header>

              <div {...stylex.props(styles.fillScrollYShrinkable)}>
                <main {...stylex.props(styles.wideCenteredX)}>
                  <section aria-labelledby="tutorial-controls-title" id="tutorial-controls">
                    <SectionHeading
                      eyebrow="Start here"
                      id="tutorial-controls-title"
                      title="Controls"
                    >
                      These are the only shortcuts you need to begin. Timeline playback takes priority
                      over camera controls while a simulation is ready.
                    </SectionHeading>
                    <div {...stylex.props(styles.gridGap32)}>
                      {CONTROL_ITEMS.map((item) => (
                        <article {...stylex.props(styles.borderedPad4)} key={item.title}>
                          <div {...stylex.props(styles.flexCenterWrap)}>
                            {item.keys.map((key) => <Keycap key={key}>{key}</Keycap>)}
                          </div>
                          <h3 {...stylex.props(styles.smSemibold)}>{item.title}</h3>
                          <p {...stylex.props(styles.xsMuted2)}>{item.body}</p>
                        </article>
                      ))}
                    </div>
                    <div {...stylex.props(styles.gridGap33)}>
                      {POINTER_ITEMS.map((item) => (
                        <article {...stylex.props(styles.flexBorderedGap3)} key={item.title}>
                          <MousePointer2 aria-hidden="true" className={stylex.props(styles.tightAccent).className} />
                          <div>
                            <h3 {...stylex.props(styles.smSemibold2)}>{item.title}</h3>
                            <p {...stylex.props(styles.xsMuted3)}>{item.body}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section aria-labelledby="tutorial-viewport-title" id="tutorial-viewport">
                    <SectionHeading eyebrow="Make it yours" id="tutorial-viewport-title" title="Tune the viewport in Settings">
                      Open Settings in the top-right toolbar. We recommend tuning these controls for
                      your mouse, display, and device before detailed authoring; changes apply to the
                      live viewport immediately.
                    </SectionHeading>
                    <div {...stylex.props(styles.gridGap32)}>
                      <SettingCard icon={<Gauge aria-hidden="true" className={stylex.props(styles.size5).className} />} title="Render quality">
                        Choose Roads Only, Low, Balanced, or High. Start with Balanced, then raise
                        quality for sharper scene context or lower it if navigation feels sluggish.
                      </SettingCard>
                      <SettingCard icon={<Camera aria-hidden="true" className={stylex.props(styles.size5).className} />} title="Camera mode">
                        Orbit is best for authoring around a road target. Fly enables free inspection
                        with pointer-lock mouse look and WASD movement.
                      </SettingCard>
                      <SettingCard icon={<SlidersHorizontal aria-hidden="true" className={stylex.props(styles.size5).className} />} title="Camera and layers">
                        Adjust Look X/Y, pan, wheel zoom, keyboard speed, and invert options. Toggle
                        buildings, vegetation, or roads to keep the viewport readable.
                      </SettingCard>
                    </div>
                  </section>

                  <div {...stylex.props(styles.gridGap4)}>
                    <GuideCard
                      icon={<CarFront aria-hidden="true" className={stylex.props(styles.size5).className} />}
                      id="tutorial-actors"
                      step="01"
                      title="Place actors"
                    >
                      <GuideStep>Open Cars, Pedestrians, or Objects from the floating toolbar.</GuideStep>
                      <GuideStep>Choose an asset, then click a valid road or surface to place it.</GuideStep>
                      {guideMode === "simple" ? (
                        <>
                          <GuideStep>Placement creates a red unfinished route interaction at the bottom of the editor.</GuideStep>
                          <GuideStep>Route drawing starts only after you click that interaction.</GuideStep>
                        </>
                      ) : (
                        <>
                          <GuideStep>Select the actor to edit its name, initial speed, driver behavior, color, and pose.</GuideStep>
                          <GuideStep>Placement warnings identify ambiguous or turning lanes; move along the road if you want a cleaner route.</GuideStep>
                        </>
                      )}
                    </GuideCard>

                    <GuideCard
                      icon={<Timer aria-hidden="true" className={stylex.props(styles.size5).className} />}
                      id="tutorial-timeline"
                      step="02"
                      title="Configure the timeline"
                    >
                      {guideMode === "simple" ? (
                        <>
                          <GuideStep>Each moving actor has one timed route. Click its red bar to configure the exact position constraints.</GuideStep>
                          <GuideStep>The actor starts at 0 seconds. Every route point represents one additional second.</GuideStep>
                          <GuideStep>Click the highlighted last point again to add a one-second wait. The actor holds its position and keeps facing the same direction.</GuideStep>
                          <GuideStep>Press Enter to finish. If the path ends early, the actor stops at its last point.</GuideStep>
                        </>
                      ) : (
                        <>
                          <GuideStep>Each actor gets a row. Right-click an empty part of that row to add an action.</GuideStep>
                          <GuideStep>Drag an interaction or its edges to move it and adjust its start and end.</GuideStep>
                          <GuideStep>Click an interaction to edit its timing, trigger, target, and dynamics.</GuideStep>
                        </>
                      )}
                      <GuideStep>Click the time grid or drag the yellow playhead to inspect another moment. Use Space to play or pause and Esc to reset.</GuideStep>
                    </GuideCard>

                    <GuideCard
                      icon={<Play aria-hidden="true" className={stylex.props(styles.size5).className} />}
                      id="tutorial-simulation"
                      step="03"
                      title="Run the simulation"
                    >
                      <GuideStep>Use the play control under Timeline—or press Space—to prepare and start browser playback.</GuideStep>
                      {guideMode === "advanced" ? (
                        <>
                          <GuideStep>Use Environment and Traffic settings for weather, map traffic, and signal behavior.</GuideStep>
                          <GuideStep>Select a traffic light to author its plan, and use a metric subject plus reasoning trace when the scenario needs decision context.</GuideStep>
                        </>
                      ) : (
                        <GuideStep>Actors meet their timed route points, then brake under normal physics after the final authored time.</GuideStep>
                      )}
                      <GuideStep>Open Simulation warnings in the top bar to review anything omitted, ambiguous, or unable to run.</GuideStep>
                      <GuideStep>Press Esc to stop, rewind to the beginning, and return to authoring.</GuideStep>
                    </GuideCard>
                  </div>

                  <section aria-labelledby="tutorial-imports-title" {...stylex.props(styles.borderedPad5)} id="tutorial-imports">
                    <div {...stylex.props(styles.flexStartGap4)}>
                      <FileInput aria-hidden="true" className={stylex.props(styles.tightAccent2).className} />
                      <div {...stylex.props(styles.narrowable)}>
                        <SectionHeading
                          eyebrow="Bring work in"
                          id="tutorial-imports-title"
                          title="Imports"
                        >
                          Importing happens from the scenario list so the editor can resolve the map
                          before opening the document.
                        </SectionHeading>
                        <div {...stylex.props(styles.gridGap34)}>
                          <ImportCard
                            icon={<Box aria-hidden="true" className={stylex.props(styles.size4).className} />}
                            title="Scenario JSON"
                          >
                            Restores a SimForge scenario document, then asks you to confirm the target map when needed.
                          </ImportCard>
                          <ImportCard
                            icon={<Route aria-hidden="true" className={stylex.props(styles.size4).className} />}
                            title="OpenSCENARIO file"
                          >
                            Opens ASAM OpenSCENARIO, analyzes its map references, and reports anything that needs resolution before import.
                          </ImportCard>
                        </div>
                      </div>
                    </div>
                  </section>
                </main>
              </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SectionHeading({
  eyebrow,
  id,
  title,
  children,
}: {
  eyebrow: string;
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p {...stylex.props(styles.capsAccentBold)}>{eyebrow}</p>
      <h2 {...stylex.props(styles.xlSemibold)} id={id}>{title}</h2>
      <p {...stylex.props(styles.smMuted)}>{children}</p>
    </div>
  );
}

function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd {...stylex.props(styles.gridCenteredMono)}>
      {children}
    </kbd>
  );
}

function GuideCard({
  icon,
  id,
  step,
  title,
  children,
}: {
  icon: ReactNode;
  id: string;
  step: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} {...stylex.props(styles.borderedPad52)} id={id}>
      <div {...stylex.props(styles.flexCenterAccent)}>
        {icon}
        <span {...stylex.props(styles.monoSemibold)}>{step}</span>
      </div>
      <h2 {...stylex.props(styles.lgSemibold2)} id={`${id}-title`}>{title}</h2>
      <ol {...stylex.props(styles.mt4StackLg)}>{children}</ol>
    </section>
  );
}

function GuideStep({ children }: { children: ReactNode }) {
  return (
    <li {...stylex.props(styles.flexXsMuted)}>
      <span aria-hidden="true" {...stylex.props(styles.tight)} />
      <span>{children}</span>
    </li>
  );
}

function ImportCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <article {...stylex.props(styles.borderedPad42)}>
      <div {...stylex.props(styles.flexCenterSm)}>
        <span {...stylex.props(styles.accent2)}>{icon}</span>
        {title}
      </div>
      <p {...stylex.props(styles.xsMuted4)}>{children}</p>
    </article>
  );
}

function SettingCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <article {...stylex.props(styles.borderedPad53)}>
      <div {...stylex.props(styles.flexCenterAccent)}>
        {icon}
        <h3 {...stylex.props(styles.smInkSemibold)}>{title}</h3>
      </div>
      <p {...stylex.props(styles.xsMuted5)}>{children}</p>
    </article>
  );
}
