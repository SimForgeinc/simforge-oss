"use client";

/**
 * The evaluation rail: a grouped, keyboard-navigable list of things the stage
 * can show. Runs, campaigns and model versions differ in what a row says, not
 * in how the list behaves, so the behaviour lives here once and each section
 * supplies rows.
 *
 * Rows are real `<button>`s. Arrow keys move focus between them — a list this
 * long is unusable if Tab is the only way down it — but the buttons stay in
 * the tab order, because a roving `tabindex` that traps focus in the rail is
 * worse than a few extra tab stops.
 */

import { useCallback, type KeyboardEvent, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RailList.stylex";

export type RailRow = {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  /** Thumbnail, glyph or status dot, at the row's leading edge. */
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onSelect: () => void;
  testId?: string;
  /** Rows nested under this one — a campaign's policies while it is open. */
  children?: RailRow[];
};

export type RailGroup = {
  key: string;
  /** Omitted for an ungrouped section: the heading would say nothing. */
  label?: string;
  note?: ReactNode;
  rows: RailRow[];
};

function Row({ row }: { row: RailRow }) {
  return (
    <li>
      <button
        type="button"
        data-rail-row=""
        data-testid={row.testId}
        aria-current={row.selected ? "true" : undefined}
        onClick={row.onSelect}
        {...stylex.props(styles.row, row.selected ? styles.rowSelected : null)}
      >
        {row.leading}
        <span {...stylex.props(styles.rowBody)}>
          <span {...stylex.props(styles.rowTitle)}>{row.title}</span>
          {row.meta ? <span {...stylex.props(styles.rowMeta)}>{row.meta}</span> : null}
        </span>
        {row.trailing ? <span {...stylex.props(styles.rowTrailing)}>{row.trailing}</span> : null}
      </button>
      {row.children && row.children.length > 0 ? (
        <ul {...stylex.props(styles.subList)}>
          {row.children.map((child) => (
            <Row key={child.id} row={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function RailList({
  title,
  count,
  actions,
  groups,
  empty,
  ariaLabel,
}: {
  title: string;
  /** Printed beside the title when the section knows how many it has. */
  count?: number | null;
  /** The section's primary action and its workspace picker. */
  actions?: ReactNode;
  groups: readonly RailGroup[];
  /** Shown instead of the list when there is nothing in it. */
  empty?: ReactNode;
  ariaLabel: string;
}) {
  // Arrow keys walk the rendered rows in document order, which is the order
  // the reader sees — including the nested policy rows.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-rail-row]")];
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : current < 0
            ? 0
            : Math.min(rows.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    rows[next]?.focus();
  }, []);

  const hasRows = groups.some((group) => group.rows.length > 0);

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerRow)}>
          <h2 {...stylex.props(styles.title)}>{title}</h2>
          {typeof count === "number" ? <span {...stylex.props(styles.count)}>{count}</span> : null}
        </div>
        {actions}
      </div>
      <div {...stylex.props(styles.scroller)} onKeyDown={onKeyDown}>
        {hasRows ? (
          groups
            .filter((group) => group.rows.length > 0)
            .map((group) => (
              <div key={group.key} {...stylex.props(styles.group)}>
                {group.label ? (
                  <div {...stylex.props(styles.groupHeader)}>
                    <span {...stylex.props(styles.groupTitle)} title={group.label}>
                      {group.label}
                    </span>
                    {group.note}
                  </div>
                ) : null}
                <ul {...stylex.props(styles.list)} aria-label={group.label ?? ariaLabel}>
                  {group.rows.map((row) => (
                    <Row key={row.id} row={row} />
                  ))}
                </ul>
              </div>
            ))
        ) : (
          <div {...stylex.props(styles.empty)}>{empty}</div>
        )}
      </div>
    </div>
  );
}
