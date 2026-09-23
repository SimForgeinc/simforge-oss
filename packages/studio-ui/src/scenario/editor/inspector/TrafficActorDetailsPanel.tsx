"use client";

import { Car } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { EditorConfigurationBlockProvider, EditorDetailsPanel } from "./EditorDetailsPanel";
import { styles } from "./TrafficActorDetailsPanel.stylex";
import { textLayout, typography } from "../../../stylex/recipes.stylex";

/**
 * One background road user the author clicked. Traffic is never an authored
 * actor: SUMO vehicles are replayed from the authoritative trace (or drawn by
 * the display-only live preview before it arrives) and City-sim cars are
 * generated from the document's traffic profile. Nothing here is editable.
 */
export type TrafficActorSelection = {
  readonly id: string;
  readonly source: "sumo-trace" | "sumo-preview" | "native";
  readonly kind: string;
  readonly catalogId: string | null;
  readonly speedMps: number | null;
};

const SOURCE_LABEL: Record<TrafficActorSelection["source"], string> = {
  "sumo-trace": "SUMO traffic",
  "sumo-preview": "SUMO traffic · live preview",
  native: "City traffic",
};

const SOURCE_DETAIL: Record<TrafficActorSelection["source"], string> = {
  "sumo-trace": "Simulated by SUMO on the server and replayed from the authoritative trace. Renders and evaluations replay exactly this vehicle.",
  "sumo-preview": "Drawn by the editor's live SUMO preview. The server's SUMO traffic replaces it once the simulation is verified.",
  native: "Generated from this scenario's traffic profile.",
};

export function TrafficActorDetailsPanel({
  actor,
  onClose,
}: {
  actor: TrafficActorSelection;
  onClose: () => void;
}) {
  return (
    // Read-only: nothing to cancel, so the playback "configure" blocker never covers it.
    <EditorConfigurationBlockProvider blocked={false}>
      <EditorDetailsPanel
        ariaLabel={`${SOURCE_LABEL[actor.source]} ${actor.id} details`}
        onClose={onClose}
        preview={(
          <div {...stylex.props(styles.preview)}>
            <Car aria-hidden="true" className={stylex.props(styles.icon).className} />
            <span {...stylex.props(typography.tag)} data-testid="traffic-actor-source">
              {SOURCE_LABEL[actor.source]}
            </span>
            <strong {...stylex.props(typography.label, textLayout.truncate)} data-testid="traffic-actor-id">
              {actor.id}
            </strong>
          </div>
        )}
        testId="scenario-traffic-actor-details-panel"
      >
        <dl {...stylex.props(styles.facts)}>
          <dt {...stylex.props(typography.meta)}>Type</dt>
          <dd {...stylex.props(typography.bodySm, styles.factValue)}>{actor.kind}</dd>
          {actor.catalogId ? (
            <>
              <dt {...stylex.props(typography.meta)}>Model</dt>
              <dd {...stylex.props(typography.bodySm, textLayout.truncate, styles.factValue)}>{actor.catalogId}</dd>
            </>
          ) : null}
          {actor.speedMps !== null ? (
            <>
              <dt {...stylex.props(typography.meta)}>Speed</dt>
              <dd {...stylex.props(typography.bodySm, typography.numeric, styles.factValue)}>
                {(actor.speedMps * 3.6).toFixed(0)} km/h
              </dd>
            </>
          ) : null}
        </dl>
        <p {...stylex.props(typography.bodySm, styles.note)}>{SOURCE_DETAIL[actor.source]}</p>
        <p {...stylex.props(typography.meta, styles.note)} data-testid="traffic-actor-read-only">
          Read-only traffic: it can&rsquo;t be selected, edited or promoted to an authored actor.
          Change the traffic source or density in the Traffic panel.
        </p>
      </EditorDetailsPanel>
    </EditorConfigurationBlockProvider>
  );
}
