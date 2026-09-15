"use client";

/**
 * The evaluation section strip: three squares down the far left, the same
 * affordance the scenarios page uses for datasets. It replaced a tab bar,
 * which cost a row of page height and read as a filter over one page rather
 * than as three places to be.
 */

import { useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { datasetHue, datasetMonogram } from "../../lib/monogram";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import type { EvaluationSection } from "./useEvaluationSelection";
import { styles } from "./EvaluationSectionStrip.stylex";

const SECTIONS: readonly { id: EvaluationSection; label: string; hint: string }[] = [
  { id: "runs", label: "Runs", hint: "Predictions from uploaded clips and rendered scenarios" },
  { id: "campaigns", label: "Campaigns", hint: "Scored policy campaigns read from the runs root" },
  { id: "models", label: "Models", hint: "The local model registry and its promotion gates" },
];

export function EvaluationSectionStrip({
  section,
  onSectionChange,
  footer,
}: {
  section: EvaluationSection;
  onSectionChange: (section: EvaluationSection) => void;
  footer?: ReactNode;
}) {
  const [hovered, setHovered] = useState<EvaluationSection | null>(null);

  return (
    <TooltipProvider delayDuration={200}>
      <nav {...stylex.props(styles.strip)} aria-label="Evaluation sections">
        <ul {...stylex.props(styles.list)}>
          {SECTIONS.map((entry) => {
            const active = entry.id === section;
            const hue = datasetHue(entry.id);
            return (
              <li
                key={entry.id}
                {...stylex.props(styles.item)}
                onMouseEnter={() => setHovered(entry.id)}
                onMouseLeave={() =>
                  setHovered((current) => (current === entry.id ? null : current))
                }
              >
                <span
                  {...stylex.props(
                    styles.pill,
                    active ? styles.pillActive : hovered === entry.id ? styles.pillHover : null,
                  )}
                  aria-hidden="true"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={entry.label}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSectionChange(entry.id)}
                      style={{
                        backgroundColor: active ? `hsl(${hue} 52% 42%)` : `hsl(${hue} 40% 30%)`,
                      }}
                      {...stylex.props(styles.icon, active ? styles.iconActive : null)}
                      data-testid={`evaluation-section-${entry.id}`}
                    >
                      <span aria-hidden="true">{datasetMonogram(entry.label)}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={12}>
                    <div {...stylex.props(styles.tooltipTitle)}>{entry.label}</div>
                    <div {...stylex.props(styles.tooltipMeta)}>{entry.hint}</div>
                  </TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ul>
        {footer ? <div {...stylex.props(styles.footer)}>{footer}</div> : null}
      </nav>
    </TooltipProvider>
  );
}
