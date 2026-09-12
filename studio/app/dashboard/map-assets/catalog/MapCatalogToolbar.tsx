"use client";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";

import { Search, LayoutGrid, Map, X, ArrowUpDown } from "lucide-react";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Toolbar, ToolbarGroup } from "@simforge-oss/studio-ui/components/ui/toolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import type { CatalogView, CatalogSort } from "./catalog-filters";
import { cn } from "@simforge-oss/studio-ui/lib/utils";

const SORT_LABELS: Record<CatalogSort, string> = {
  date: "Date Added",
  name: "Name",
  mileage: "Mileage",
};

interface MapCatalogToolbarProps {
  query: string;
  onQueryChange: (q: string) => void;
  sort: CatalogSort;
  onSortChange: (s: CatalogSort) => void;
  view: CatalogView;
  onViewChange: (v: CatalogView) => void;
  resultCount: number;
}

export function MapCatalogToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  view,
  onViewChange,
  resultCount,
}: MapCatalogToolbarProps) {
  return (
    <Toolbar>
      {/* Search */}
      <div className={stylex.props(styles.s_153).className}>
        <Search className={stylex.props(styles.s_154).className} />
        <Input
          type="search"
          placeholder="Search maps by name, city, tag..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className={stylex.props(styles.s_155).className}
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            className={stylex.props(styles.s_156).className}
          >
            <X className={stylex.props(styles.s_991).className} />
          </button>
        )}
      </div>

      {/* Result count */}
      <span className={stylex.props(styles.s_158).className}>
        {resultCount} {resultCount === 1 ? "map" : "maps"}
      </span>

      <ToolbarGroup className={stylex.props(styles.s_159).className}>
        {/* Sort */}
        <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={stylex.props(styles.s_160).className}>
            <ArrowUpDown className={stylex.props(styles.s_991).className} />
            {SORT_LABELS[sort]}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onSortChange("date")}>Date Added</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSortChange("name")}>Name</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSortChange("mileage")}>Mileage</DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>

      {/* View toggle */}
        <div className={stylex.props(styles.s_162).className}>
        <button
          type="button"
          onClick={() => onViewChange("grid")}
          className={stylex.props(styles.u_908, styles.u_928, styles.u_917, styles.u_951, styles.u_937, styles.u_943, styles.u_970).className}
          title="Grid view"
        >
          <LayoutGrid className={stylex.props(styles.s_991).className} />
          Grid
        </button>
        <button
          type="button"
          onClick={() => onViewChange("map")}
          className={stylex.props(styles.u_908, styles.u_928, styles.u_917, styles.u_951, styles.u_937, styles.u_943, styles.u_970).className}
          title="Map view"
        >
          <Map className={stylex.props(styles.s_991).className} />
          Map
        </button>
        </div>
      </ToolbarGroup>
    </Toolbar>
  );
}
