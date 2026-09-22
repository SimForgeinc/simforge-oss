/**
 * TEMPLATE: the shape every Studio component should have. Copy this file and
 * `TemplatePanel.stylex.ts`, rename, and delete what you do not need. It is
 * compiled, typechecked, linted and tested like any component
 * (test/unit/components/template-panel.test.tsx), so it cannot drift from
 * the system it demonstrates. The rules it follows are in
 * docs/engineering/studio-style-guide.md.
 *
 * What it shows, top to bottom:
 *  1. Primitives first: `Button`, `IconButton`, `Chip`, `Dot`, `MetaLabel`
 *     take props for their look (`variant`, `size`, `tone`), never `xstyle`.
 *  2. Recipes for looks the primitives do not cover: `surface`, `hairline`,
 *     `typography`, `interactive`, `focus`, `textLayout`.
 *  3. One `stylex.props` per element, in the order recipes, local layout,
 *     state, caller `xstyle`.
 *  4. A caller's `xstyle` is typed `PlacementStyle`: it can place this
 *     panel, not reskin it.
 *  5. State from the platform and from data attributes, and a child that
 *     reacts to its row's hover through a marker, not a class.
 */
import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { MoreHorizontal } from "lucide-react";

import { focus, hairline, interactive, surface, textLayout, typography } from "../../stylex/recipes.stylex";
import { MetaLabel } from "../stylex/MetaLabel";
import { type PlacementStyle, type Tone } from "../stylex/surface";
import { Button } from "../ui/button";
import { Chip } from "../ui/chip";
import { Dot } from "../ui/dot";
import { IconButton } from "../ui/icon-button";
import { rowMarker, styles } from "./TemplatePanel.stylex";

export type TemplateItem = {
  id: string;
  name: string;
  detail: string;
  status: "ready" | "running" | "failed";
};

/** Status to tone: a lookup, so a new status is one line and no new colour. */
const STATUS_TONE: Record<TemplateItem["status"], Tone> = {
  ready: "positive",
  running: "accent",
  failed: "critical",
};

export function TemplatePanel({
  title,
  items,
  selectedId,
  onSelect,
  onCreate,
  xstyle,
}: {
  title: string;
  items: readonly TemplateItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** Where the panel sits in its parent: placement only. */
  xstyle?: PlacementStyle;
}) {
  return (
    <section {...stylex.props(surface.card, hairline.all, styles.root, xstyle)}>
      <header {...stylex.props(hairline.bottom, styles.header)}>
        <div {...stylex.props(styles.headerText)}>
          <MetaLabel>{items.length} items</MetaLabel>
          <h2 {...stylex.props(typography.title, textLayout.truncate)}>{title}</h2>
        </div>
        <Button variant="accent" size="md" onClick={onCreate}>
          New item
        </Button>
      </header>
      <ul {...stylex.props(styles.list)}>
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <li key={item.id} {...stylex.props(hairline.bottom, hairline.subtle, rowMarker, styles.item)}>
              <button
                type="button"
                aria-current={selected || undefined}
                onClick={() => onSelect(item.id)}
                {...stylex.props(
                  focus.ringInset,
                  interactive.base,
                  interactive.hoverFill,
                  styles.row,
                  selected && interactive.selected,
                )}
              >
                <Dot tone={STATUS_TONE[item.status]} pulse={item.status === "running"} />
                <span {...stylex.props(styles.rowText)}>
                  <span {...stylex.props(typography.label, textLayout.truncate)}>{item.name}</span>
                  <span {...stylex.props(typography.meta, textLayout.truncate)}>{item.detail}</span>
                </span>
                <Chip tone={STATUS_TONE[item.status]}>{item.status}</Chip>
              </button>
              <span {...stylex.props(styles.rowAction)}>
                <IconButton label={`More actions for ${item.name}`} size="xs">
                  <MoreHorizontal />
                </IconButton>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
