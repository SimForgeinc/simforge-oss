// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "../../../../src/components/ui/table";

describe("Table", () => {
  it("renders a table element", () => {
    const html = renderToString(<Table />);
    expect(html).toContain("<table");
  });



  it("merges a custom className", () => {
    const html = renderToString(<Table className="my-table" />);
    expect(html).toContain("my-table");
  });

  it("passes through HTML attributes", () => {
    const html = renderToString(<Table data-testid="data-table" />);
    expect(html).toContain('data-testid="data-table"');
  });
});

describe("TableHeader", () => {
  it("renders a thead element", () => {
    const html = renderToString(<table><TableHeader /></table>);
    expect(html).toContain("<thead");
  });


  it("merges a custom className", () => {
    const html = renderToString(<table><TableHeader className="custom-header" /></table>);
    expect(html).toContain("custom-header");
  });
});

describe("TableBody", () => {
  it("renders a tbody element", () => {
    const html = renderToString(<table><TableBody /></table>);
    expect(html).toContain("<tbody");
  });


  it("merges a custom className", () => {
    const html = renderToString(<table><TableBody className="custom-body" /></table>);
    expect(html).toContain("custom-body");
  });
});

describe("TableFooter", () => {
  it("renders a tfoot element", () => {
    const html = renderToString(<table><TableFooter /></table>);
    expect(html).toContain("<tfoot");
  });


  it("merges a custom className", () => {
    const html = renderToString(<table><TableFooter className="custom-footer" /></table>);
    expect(html).toContain("custom-footer");
  });
});

describe("TableRow", () => {
  it("renders a tr element", () => {
    const html = renderToString(<table><tbody><TableRow /></tbody></table>);
    expect(html).toContain("<tr");
  });



  it("merges a custom className", () => {
    const html = renderToString(<table><tbody><TableRow className="custom-row" /></tbody></table>);
    expect(html).toContain("custom-row");
  });

  it("passes through HTML attributes", () => {
    const html = renderToString(<table><tbody><TableRow data-testid="row-1" /></tbody></table>);
    expect(html).toContain('data-testid="row-1"');
  });
});

describe("TableHead", () => {
  it("renders a th element", () => {
    const html = renderToString(<table><thead><tr><TableHead>Name</TableHead></tr></thead></table>);
    expect(html).toContain("<th");
    expect(html).toContain("Name");
  });



  it("merges a custom className", () => {
    const html = renderToString(<table><thead><tr><TableHead className="custom-th" /></tr></thead></table>);
    expect(html).toContain("custom-th");
  });
});

describe("TableCell", () => {
  it("renders a td element", () => {
    const html = renderToString(<table><tbody><tr><TableCell>Value</TableCell></tr></tbody></table>);
    expect(html).toContain("<td");
    expect(html).toContain("Value");
  });



  it("merges a custom className", () => {
    const html = renderToString(<table><tbody><tr><TableCell className="custom-td" /></tr></tbody></table>);
    expect(html).toContain("custom-td");
  });

  it("passes through HTML attributes", () => {
    const html = renderToString(<table><tbody><tr><TableCell colSpan={3} /></tr></tbody></table>);
    // React SSR renders colSpan (camelCase) in the HTML output
    expect(html).toContain('colSpan="3"');
  });
});

describe("TableCaption", () => {
  it("renders a caption element", () => {
    const html = renderToString(<table><TableCaption>Results</TableCaption></table>);
    expect(html).toContain("<caption");
    expect(html).toContain("Results");
  });


  it("merges a custom className", () => {
    const html = renderToString(<table><TableCaption className="custom-caption">Caption</TableCaption></table>);
    expect(html).toContain("custom-caption");
  });
});

describe("Table composition", () => {
  it("renders a complete table structure without errors", () => {
    const html = renderToString(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Scenario A</TableCell>
            <TableCell>RUNNING</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Total: 1</TableCell>
          </TableRow>
        </TableFooter>
        <TableCaption>Simulation scenarios</TableCaption>
      </Table>
    );
    expect(html).toContain("Name");
    expect(html).toContain("Scenario A");
    expect(html).toContain("RUNNING");
    expect(html).toContain("Total: 1");
    expect(html).toContain("Simulation scenarios");
  });
});
