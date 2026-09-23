"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenariosTab.stylex";

import type { MapTemplateScenarioRow } from "@/app/lib/db/scenario-query-store";
import { hairline, motionRecipe, textLayout, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

interface ScenariosTabProps {
  templateScenarios: MapTemplateScenarioRow[];
  onCreateBlankScenario?: () => void;
  createBlankBusy?: boolean;
  onUseTemplate?: (templateScenarioId: string) => void;
  templateCreateId?: string | null;
}

export function ScenariosTab({
  templateScenarios,
  onCreateBlankScenario,
  createBlankBusy = false,
  onUseTemplate,
  templateCreateId = null,
}: ScenariosTabProps) {
  return (
    <div {...stylex.props(styles.scenariosContainer)}>
      <section {...stylex.props([hairline.all, styles.newScenarioSection])}>
        <div {...stylex.props(styles.newScenarioRow)}>
          <div {...stylex.props(styles.scenarioContentStack)}>
            <h3 {...stylex.props(styles.newScenarioTitle)}>
              New Scenario
            </h3>
            <p {...stylex.props(styles.newScenarioDescription)}>
              Starts from this map in your default dataset.
            </p>
          </div>
          <button
            type="button"
            onClick={onCreateBlankScenario}
            disabled={!onCreateBlankScenario || createBlankBusy}
            {...stylex.props([motionRecipe.colors, [hairline.all, styles.scenarioActionButton]])}
          >
            {createBlankBusy ? "Creating..." : "Create Scenario"}
          </button>
        </div>
      </section>

      <section>
        <h3 {...stylex.props([typography.eyebrow, styles.templateScenariosTitle])}>
          Template Scenarios
        </h3>
        {templateScenarios.length === 0 ? (
          <p {...stylex.props(styles.emptyTemplatesMessage)}>
            No template scenarios for this map yet.
          </p>
        ) : (
          <ul {...stylex.props(styles.templateScenariosList)}>
            {templateScenarios.map((scenario) => {
              const actorCount = scenario.actor_count ?? 0;
              const busy = templateCreateId === scenario.id;
              return (
                <li
                  key={scenario.id}
                  {...stylex.props([hairline.all, styles.templateScenarioItem])}
                >
                  <div {...stylex.props(styles.scenarioContentStack)}>
                    <p {...stylex.props([textLayout.truncate, styles.templateScenarioName])}>
                      {scenario.display_name ?? "Untitled Template"}
                    </p>
                    <p {...stylex.props(styles.templateActorCount)}>
                      {actorCount} actor{actorCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onUseTemplate?.(scenario.id)}
                    disabled={busy}
                    {...stylex.props([motionRecipe.colors, [hairline.all, styles.scenarioActionButton]])}
                  >
                    {busy ? "Creating..." : "Use Template"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
