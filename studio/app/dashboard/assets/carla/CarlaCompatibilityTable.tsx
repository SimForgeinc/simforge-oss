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
import { dialog } from "../asset-dialogs.stylex";

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
    <section aria-label="CARLA compatibility catalog" {...stylex.props(dialog.panel)}>
      <div {...stylex.props(dialog.tableTools)}>
        <div {...stylex.props(dialog.searchWrap)}>
          <Search {...stylex.props(dialog.searchIcon)} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search objects, classes, or blueprints"
            aria-label="Search CARLA compatibility"
          />
        </div>
        <SelectMenu
          value={status}
          onChange={(value) => setStatus(value as typeof status)}
          options={STATUS_OPTIONS}
          label="Filter by compatibility status"
          {...stylex.props(dialog.toolbarSelect, dialog.toolbarCarla)}
        />
      </div>

      <div {...stylex.props(dialog.tableWrap)}>
        <Table {...stylex.props(dialog.table)}>
          <TableHeader>
            <TableRow>
              <TableHead>Object</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Dimensions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>CARLA blueprint</TableHead>
              <TableHead>Agreement</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.map((row) => {
              const native = row.compatibility.status === "native" ? row.compatibility : null;
              return (
                <TableRow key={row.catalogId}>
                  <TableCell {...stylex.props(dialog.tableCell)}>
                    <p {...stylex.props(dialog.cellStrong)}>{row.label}</p>
                    <p {...stylex.props(dialog.mutedText)}>{row.catalogId}</p>
                  </TableCell>
                  <TableCell {...stylex.props(dialog.tableCell, dialog.cellMuted)}>{row.source}</TableCell>
                  <TableCell {...stylex.props(dialog.tableCell, dialog.cellMuted)}>{row.objectClass.replaceAll("_", " ")}</TableCell>
                  <TableCell {...stylex.props(dialog.tableCell, dialog.cellMuted)}>{row.dimensions ?? "—"}</TableCell>
                  <TableCell {...stylex.props(dialog.tableCell)}><CarlaCompatibilityPill compatibility={row.compatibility} size="sm" /></TableCell>
                  <TableCell {...stylex.props(dialog.tableCell)}>
                    {row.compatibility.status === "native"
                      ? <span {...stylex.props(dialog.cellStrong)}>{row.compatibility.blueprintId}</span>
                      : <span {...stylex.props(dialog.cellMuted)}>{row.compatibility.reason}</span>}
                  </TableCell>
                  <TableCell {...stylex.props(dialog.tableCell, dialog.cellMuted)}>{native?.dimensionalAgreement ?? "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {filteredRows.length === 0 ? (
          <div {...stylex.props(dialog.tableEmpty)}>
            No catalog objects match these filters.
          </div>
        ) : null}
      </div>
      <p {...stylex.props(dialog.mutedText)}>Showing {filteredRows.length.toLocaleString()} of {rows.length.toLocaleString()} objects</p>
    </section>
  );
}
