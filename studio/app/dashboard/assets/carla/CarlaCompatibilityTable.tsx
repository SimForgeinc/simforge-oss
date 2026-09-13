"use client";

import { Search } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { CarlaCompatibilityPill } from "@simforge-oss/studio-ui/components/CarlaCompatibilityPill";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { SelectMenu } from "@simforge-oss/studio-ui/components/ui/select-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@simforge-oss/studio-ui/components/ui/table";
import type { CarlaCompatibility } from "@simforge-oss/studio-ui/lib/scenario/carla-compatibility";
import { carla } from "./carla-table.stylex";

export interface CarlaCompatibilityRow {
  catalogId: string;
  label: string;
  source: string;
  objectClass: string;
  dimensions: string | null;
  compatibility: CarlaCompatibility;
}

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "native", label: "CARLA ready" },
  { value: "generated-pack", label: "CARLA pack required" },
  { value: "browser-only", label: "Browser only" },
];

export function CarlaCompatibilityTable({ rows }: { rows: CarlaCompatibilityRow[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | CarlaCompatibility["status"]>("all");

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => {
      if (status !== "all" && row.compatibility.status !== status) return false;
      if (!needle) return true;
      const detail = row.compatibility.status === "native"
        ? row.compatibility.blueprintId
        : row.compatibility.reason;
      return [row.catalogId, row.label, row.source, row.objectClass, detail]
        .some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [query, rows, status]);

  return (
    <section aria-label="CARLA compatibility catalog" {...stylex.props(carla.section)}>
      <div {...stylex.props(carla.tools)}>
        <div {...stylex.props(carla.searchWrap)}>
          <Search {...stylex.props(carla.searchIcon)} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search objects, classes, or blueprints"
            aria-label="Search CARLA compatibility"
            xstyle={carla.searchInput}
          />
        </div>
        <SelectMenu
          value={status}
          onChange={(value) => setStatus(value as typeof status)}
          options={STATUS_OPTIONS}
          label="Filter by compatibility status"
          xstyle={carla.select}
        />
      </div>

      <div {...stylex.props(carla.tableWrap)}>
        <Table xstyle={carla.table}>
          <TableHeader xstyle={carla.header}>
            <TableRow xstyle={carla.headerRow}>
              <TableHead xstyle={carla.head}>Object</TableHead>
              <TableHead xstyle={carla.head}>Source</TableHead>
              <TableHead xstyle={carla.head}>Class</TableHead>
              <TableHead xstyle={carla.head}>Dimensions</TableHead>
              <TableHead xstyle={carla.head}>Status</TableHead>
              <TableHead xstyle={carla.head}>CARLA blueprint</TableHead>
              <TableHead xstyle={carla.head}>Agreement</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.map((row) => {
              const native = row.compatibility.status === "native" ? row.compatibility : null;
              return (
                <TableRow key={row.catalogId} xstyle={carla.row}>
                  <TableCell xstyle={carla.cell}>
                    <p {...stylex.props(carla.label)}>{row.label}</p>
                    <p {...stylex.props(carla.catalogId)}>{row.catalogId}</p>
                  </TableCell>
                  <TableCell xstyle={[carla.cell, carla.cellMuted]}>{row.source}</TableCell>
                  <TableCell xstyle={[carla.cell, carla.cellCapitalize, carla.cellMuted]}>{row.objectClass.replaceAll("_", " ")}</TableCell>
                  <TableCell xstyle={[carla.cell, carla.cellNumeric, carla.cellMuted]}>{row.dimensions ?? "—"}</TableCell>
                  <TableCell xstyle={carla.cell}><CarlaCompatibilityPill compatibility={row.compatibility} size="sm" /></TableCell>
                  <TableCell xstyle={[carla.blueprintCell, carla.cell]}>
                    {row.compatibility.status === "native"
                      ? <span {...stylex.props(carla.blueprintId)}>{row.compatibility.blueprintId}</span>
                      : <span {...stylex.props(carla.reason)}>{row.compatibility.reason}</span>}
                  </TableCell>
                  <TableCell xstyle={[carla.cell, carla.cellCapitalize, carla.cellMuted]}>{native?.dimensionalAgreement ?? "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {filteredRows.length === 0 ? (
          <div {...stylex.props(carla.empty)}>
            No catalog objects match these filters.
          </div>
        ) : null}
      </div>
      <p {...stylex.props(carla.count)}>Showing {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()} objects</p>
    </section>
  );
}
