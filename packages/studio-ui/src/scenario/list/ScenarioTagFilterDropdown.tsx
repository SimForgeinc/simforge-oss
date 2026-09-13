"use client";

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
import { chip, menu } from "../scenario-controls.stylex";

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
          variant="outline"
          xstyle={[chip.base, hasActiveFilter ? chip.on : chip.off]}
          aria-label="Filter scenarios"
        >
          <Filter className="size-3.5" aria-hidden="true" />
          Filter
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
              <span className="min-w-0 flex-1 truncate">{creator.label}</span>
              <span className="text-micro text-muted-foreground">{creator.count}</span>
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
                className="size-2 border border-border"
                style={tag.color ? { backgroundColor: tag.color } : undefined}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{tag.label}</span>
              <span className="text-micro text-muted-foreground">{tag.documentCount}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
