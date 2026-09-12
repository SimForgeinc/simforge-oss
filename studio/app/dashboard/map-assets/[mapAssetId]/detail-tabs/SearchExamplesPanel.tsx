"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../../map-assets.stylex";

import { cn } from "@simforge-oss/studio-ui/lib/utils";
import { SEARCH_EXAMPLE_GROUPS, type SearchExample } from "./search-examples";

interface SearchExamplesPanelProps {
  /** Submit a query — usually the page's `onSubmitSearch`. Available-tier
   *  examples call this; coming-soon chips are muted and non-interactive. */
  onRunExample: (query: string) => void;
}

/**
 * Empty-state panel shown below the search input when no query is active.
 * The panel *is* the tutorial: each chip is a one-click demo of a supported
 * query shape. Groups are rendered in roadmap order so `available` rows
 * come first and `coming soon` rows sit below as aspirational teases.
 */
export function SearchExamplesPanel({ onRunExample }: SearchExamplesPanelProps) {
  return (
    <div className={stylex.props(styles.s_802).className}>
      {SEARCH_EXAMPLE_GROUPS.map((group) => (
        <section key={group.id} className={stylex.props(styles.s_960).className}>
          <header className={stylex.props(styles.s_908).className}>
            <h3 className={stylex.props(styles.s_805).className}>
              {group.title}
            </h3>
            {group.tier === "coming_soon" ? (
              <span className={stylex.props(styles.s_806).className}>
                Coming soon
              </span>
            ) : null}
          </header>
          <div className={stylex.props(styles.s_807).className}>
            {group.examples.map((example) => (
              <Chip key={example.label} example={example} onRun={onRunExample} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface ChipProps {
  example: SearchExample;
  onRun: (query: string) => void;
}

function Chip({ example, onRun }: ChipProps) {
  const isAvailable = example.tier === "available";
  return (
    <button
      type="button"
      disabled={!isAvailable}
      onClick={() => isAvailable && onRun(example.query)}
      className={stylex.props(styles.u_952, styles.u_903, styles.u_937, styles.u_942, styles.u_970).className}
      title={isAvailable ? `Run search: ${example.query}` : "Coming in the next release"}
    >
      {example.label}
    </button>
  );
}
