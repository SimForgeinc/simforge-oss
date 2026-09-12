import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./table.stylex";

type TableStyle = stylex.StyleXStyles;
type TableProps = React.HTMLAttributes<HTMLTableElement> & { xstyle?: TableStyle };
type SectionProps = React.HTMLAttributes<HTMLTableSectionElement> & { xstyle?: TableStyle };
type RowProps = React.HTMLAttributes<HTMLTableRowElement> & { xstyle?: TableStyle };
type HeadProps = React.ThHTMLAttributes<HTMLTableCellElement> & { xstyle?: TableStyle };
type CellProps = React.TdHTMLAttributes<HTMLTableCellElement> & { xstyle?: TableStyle };
type CaptionProps = React.HTMLAttributes<HTMLTableCaptionElement> & { xstyle?: TableStyle };

const TABLE_HEADER_COMPAT = "[&_tr]:border-b";
const TABLE_BODY_COMPAT = "[&_tr:last-child]:border-0";
const TABLE_FOOTER_COMPAT = "[&>tr]:last:border-b-0";
const TABLE_CHECKBOX_COMPAT = "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]";

const withCompat = (compat: string, className?: string) =>
  [compat, className].filter(Boolean).join(" ");

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <div {...mergeStyleProps(stylex.props(styles.wrapper))}>
      <table
        ref={ref}
        {...props}
        {...mergeStyleProps(stylex.props(styles.table, xstyle), className, style)}
      />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, SectionProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <thead
      ref={ref}
      {...props}
      {...mergeStyleProps(
        stylex.props(styles.header, xstyle),
        withCompat(TABLE_HEADER_COMPAT, className),
        style,
      )}
    />
  ),
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, SectionProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <tbody
      ref={ref}
      {...props}
      {...mergeStyleProps(
        stylex.props(styles.body, xstyle),
        withCompat(TABLE_BODY_COMPAT, className),
        style,
      )}
    />
  ),
);
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, SectionProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <tfoot
      ref={ref}
      {...props}
      {...mergeStyleProps(
        stylex.props(styles.footer, xstyle),
        withCompat(TABLE_FOOTER_COMPAT, className),
        style,
      )}
    />
  ),
);
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, RowProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <tr
      ref={ref}
      {...props}
      {...mergeStyleProps(stylex.props(styles.row, xstyle), className, style)}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, HeadProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <th
      ref={ref}
      {...props}
      {...mergeStyleProps(
        stylex.props(styles.head, xstyle),
        withCompat(TABLE_CHECKBOX_COMPAT, className),
        style,
      )}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, CellProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <td
      ref={ref}
      {...props}
      {...mergeStyleProps(
        stylex.props(styles.cell, xstyle),
        withCompat(TABLE_CHECKBOX_COMPAT, className),
        style,
      )}
    />
  ),
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, CaptionProps>(
  ({ className, style, xstyle, ...props }, ref) => (
    <caption
      ref={ref}
      {...props}
      {...mergeStyleProps(stylex.props(styles.caption, xstyle), className, style)}
    />
  ),
);
TableCaption.displayName = "TableCaption";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
