// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { PageHeader } from "../../../../src/components/ui/page-header";
import { Toolbar, ToolbarGroup } from "../../../../src/components/ui/toolbar";
import { EmptyState } from "../../../../src/components/ui/empty-state";

function render(element: React.ReactElement): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("expected a rendered element");
  return root;
}

describe("standard page structure", () => {
  it("renders a page title, description, and action zone with heading semantics", () => {
    const header = render(
      <PageHeader
        eyebrow="Library"
        title="Maps"
        description="Browse environments."
        actions={<button type="button">Add map</button>}
      />,
    );

    expect(header.tagName).toBe("HEADER");
    expect(header.querySelector("h1")?.textContent).toBe("Maps");
    expect(header.textContent).toContain("Library");
    expect(header.textContent).toContain("Browse environments.");

    const action = header.querySelector("button");
    expect(action?.textContent).toBe("Add map");
    expect(action?.closest("h1")).toBeNull();
  });

  it("omits the optional eyebrow and description when they are not supplied", () => {
    const header = render(<PageHeader title="Maps" />);

    expect(header.querySelector("h1")?.textContent).toBe("Maps");
    expect(header.querySelector("p")).toBeNull();
  });

  it("renders grouped toolbar controls inside a nested group", () => {
    const toolbar = render(
      <Toolbar>
        <span>Search</span>
        <ToolbarGroup>
          <button type="button">Sort</button>
        </ToolbarGroup>
      </Toolbar>,
    );

    expect(toolbar.textContent).toContain("Search");

    const group = toolbar.lastElementChild;
    expect(group?.tagName).toBe("DIV");
    expect(group?.querySelector("button")?.textContent).toBe("Sort");
  });

  it("renders a task-oriented empty state with an optional action", () => {
    const emptyState = render(
      <EmptyState title="No maps yet" description="Add your first map." action={<button type="button">Add map</button>} />,
    );

    expect(emptyState.querySelector("h2")?.textContent).toBe("No maps yet");
    expect(emptyState.querySelector("p")?.textContent).toBe("Add your first map.");
    expect(emptyState.querySelector("button")?.textContent).toBe("Add map");
  });

  it("renders an empty state without a description or action", () => {
    const emptyState = render(<EmptyState title="No maps yet" />);

    expect(emptyState.querySelector("h2")?.textContent).toBe("No maps yet");
    expect(emptyState.querySelector("p")).toBeNull();
    expect(emptyState.querySelector("button")).toBeNull();
  });
});
