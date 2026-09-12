"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../../map-assets.stylex";

import type { MapTemplateScenarioRow } from "@/app/lib/db/scenario-query-store";

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
    <div className={stylex.props(styles.s_810).className}>
      <section className={stylex.props(styles.s_811).className}>
        <div className={stylex.props(styles.s_812).className}>
          <div className={stylex.props(styles.s_919).className}>
            <h3 className={stylex.props(styles.s_814).className}>
              New Scenario
            </h3>
            <p className={stylex.props(styles.s_815).className}>
              Starts from this map in your default dataset.
            </p>
          </div>
          <button
            type="button"
            onClick={onCreateBlankScenario}
            disabled={!onCreateBlankScenario || createBlankBusy}
            className={stylex.props(styles.s_824).className}
          >
            {createBlankBusy ? "Creating..." : "Create Scenario"}
          </button>
        </div>
      </section>

      <section>
        <h3 className={stylex.props(styles.s_849).className}>
          Template Scenarios
        </h3>
        {templateScenarios.length === 0 ? (
          <p className={stylex.props(styles.s_818).className}>
            No template scenarios for this map yet.
          </p>
        ) : (
          <ul className={stylex.props(styles.s_819).className}>
            {templateScenarios.map((scenario) => {
              const actorCount = scenario.actor_count ?? 0;
              const busy = templateCreateId === scenario.id;
              return (
                <li
                  key={scenario.id}
                  className={stylex.props(styles.s_820).className}
                >
                  <div className={stylex.props(styles.s_919).className}>
                    <p className={stylex.props(styles.s_861).className}>
                      {scenario.display_name ?? "Untitled Template"}
                    </p>
                    <p className={stylex.props(styles.s_955).className}>
                      {actorCount} actor{actorCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onUseTemplate?.(scenario.id)}
                    disabled={busy}
                    className={stylex.props(styles.s_824).className}
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
