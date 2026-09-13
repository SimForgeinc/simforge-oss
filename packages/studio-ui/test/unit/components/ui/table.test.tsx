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

function render(element: React.ReactElement): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("expected a rendered element");
  return root;
}

describe("Table", () => {
  it("renders a table inside a scroll wrapper", () => {
    const wrapper = render(<Table />);

    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.children).toHaveLength(1);
    expect(wrapper.firstElementChild?.tagName).toBe("TABLE");
  });

  it("forwards attributes onto the table element, not the wrapper", () => {
    const wrapper = render(<Table data-testid="data-table" />);

    expect(wrapper.getAttribute("data-testid")).toBeNull();
    expect(wrapper.querySelector("table")!.getAttribute("data-testid")).toBe("data-table");
  });
});

describe("Table sections", () => {
  it("render the matching table elements", () => {
    const table = render(
      <table>
        <TableCaption>Caption</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Value</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
          </TableRow>
        </TableFooter>
      </table>,
    );

    expect(table.querySelector("caption")?.textContent).toBe("Caption");
    expect(table.querySelector("thead th")?.textContent).toBe("Name");
    expect(table.querySelector("tbody td")?.textContent).toBe("Value");
    expect(table.querySelector("tfoot td")?.textContent).toBe("Total");
  });

  it("forward attributes onto rows and cells", () => {
    const table = render(
      <table>
        <tbody>
          <TableRow data-testid="row-1">
            <TableCell colSpan={3} />
          </TableRow>
        </tbody>
      </table>,
    );

    expect(table.querySelector("tr")?.getAttribute("data-testid")).toBe("row-1");
    expect(table.querySelector("td")?.getAttribute("colspan")).toBe("3");
  });
});

describe("Table composition", () => {
  it("renders a complete table structure", () => {
    const wrapper = render(
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

    expect(Array.from(wrapper.querySelectorAll("thead th"), (cell) => cell.textContent)).toEqual([
      "Name",
      "Status",
    ]);
    expect(Array.from(wrapper.querySelectorAll("tbody td"), (cell) => cell.textContent)).toEqual([
      "Scenario A",
      "RUNNING",
    ]);
    expect(wrapper.querySelector("tfoot td")?.textContent).toBe("Total: 1");
    expect(wrapper.querySelector("caption")?.textContent).toBe("Simulation scenarios");
  });
});
