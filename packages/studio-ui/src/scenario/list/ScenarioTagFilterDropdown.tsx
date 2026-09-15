"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioTagFilterDropdown.stylex";
import { Filter } from "lucide-react";
import type { ScenarioTagDto } from "../../lib/scenario/contracts";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { chip, control, menu } from "../scenario-controls.stylex";

export type ScenarioCreatorFilterOption = {
  value: string;
  label: string;
  count: number;
};

export function ScenarioTagFilterDropdown({
  tags,
  creatorOptions,
  selectedTagFilter,
  selectedCreatorFilter,
  onSelectTagFilter,
  onSelectCreatorFilter,
}: {
  tags: ScenarioTagDto[];
  creatorOptions: ScenarioCreatorFilterOption[];
  selectedTagFilter: string | null;
  selectedCreatorFilter: string | null;
  onSelectTagFilter: (tagId: string | null) => void;
  onSelectCreatorFilter: (creator: string | null) => void;
}) {
  const selectedTag = tags.find((tag) => tag.id === selectedTagFilter) ?? null;
  const selectedCreator =
    creatorOptions.find((creator) => creator.value === selectedCreatorFilter) ?? null;
  const hasActiveFilter = Boolean(selectedTag || selectedCreator);
  const showingAll = selectedTagFilter === null && selectedCreatorFilter === null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          xstyle={[chip.base, control.iconSm, hasActiveFilter ? chip.on : chip.off]}
          aria-label="Filter scenarios"
          title="Filter scenarios"
        >
          <Filter {...stylex.props(styles.filterFilter)} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" xstyle={menu.width220}>
        <DropdownMenuItem
          data-scenario-filter-all
          onSelect={() => {
            onSelectTagFilter(null);
            onSelectCreatorFilter(null);
          }}
          xstyle={[menu.metaItem, showingAll ? menu.selected : null]}
        >
          <span
            className={cn(
              "size-2 border border-primary/45",
              showingAll ? "bg-primary" : "bg-transparent",
            )}
            aria-hidden="true"
          />
          All scenarios
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel xstyle={menu.metaLabel}>
          Created by
        </DropdownMenuLabel>
        {creatorOptions.length === 0 ? (
          <DropdownMenuItem disabled>No creators yet</DropdownMenuItem>
        ) : (
          creatorOptions.map((creator) => (
            <DropdownMenuItem
              key={creator.value}
              data-scenario-filter-creator={creator.value}
              onSelect={() => {
                onSelectCreatorFilter(creator.value);
                onSelectTagFilter(null);
              }}
              xstyle={[
                menu.metaItemTight,
                selectedCreatorFilter === creator.value ? menu.selected : null,
              ]}
            >
              <span
                className={cn(
                  "size-2 border border-primary/45",
                  selectedCreatorFilter === creator.value ? "bg-primary" : "bg-transparent",
                )}
                aria-hidden="true"
              />
              <span {...stylex.props(styles.spanTruncate)}>{creator.label}</span>
              <span {...stylex.props(styles.spanMicro)}>{creator.count}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel xstyle={menu.metaLabel}>
          Tags
        </DropdownMenuLabel>
        {tags.length === 0 ? (
          <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>
        ) : (
          tags.map((tag) => (
            <DropdownMenuItem
              key={tag.id}
              data-scenario-filter-tag-id={tag.id}
              onSelect={() => {
                onSelectTagFilter(tag.id);
                onSelectCreatorFilter(null);
              }}
              xstyle={[menu.metaItem, selectedTagFilter === tag.id ? menu.selected : null]}
            >
              {/*
                A tag's colour is operator-chosen data, so it arrives as an inline style rather than
                as a class. The border is a token so an unset colour still reads as a swatch.
              */}
              <span
                {...stylex.props(styles.spanIcon)}
                style={tag.color ? { backgroundColor: tag.color } : undefined}
                aria-hidden="true"
              />
              <span {...stylex.props(styles.spanTruncate2)}>{tag.label}</span>
              <span {...stylex.props(styles.spanMicro2)}>{tag.documentCount}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
