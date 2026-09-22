// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { cleanup, render as renderDom, screen } from "@testing-library/react";
import { PageHeader } from "../../../../src/components/ui/page-header";
import { TopBarSlotProvider, useTopBarSlotContext } from "../../../../src/components/TopBarSlot";
import { Toolbar, ToolbarGroup } from "../../../../src/components/ui/toolbar";
import { EmptyState } from "../../../../src/components/ui/empty-state";

function render(element: React.ReactElement): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("expected a rendered element");
  return root;
}

/** What the top bar would show: the registered title, context and actions. */
function RouteHeaderReadout() {
  const header = useTopBarSlotContext()?.header;
  return (
    <div>
      <h1>{header?.title ?? ""}</h1>
      <span data-testid="route-context">{header?.context}</span>
      {header?.actions}
    </div>
  );
}

describe("standard page structure", () => {
  afterEach(cleanup);

  it("publishes the title, context and actions to the route header and keeps only the description in the body", () => {
    const { container } = renderDom(
      <TopBarSlotProvider>
        <RouteHeaderReadout />
        <PageHeader
          eyebrow="Library"
          title="Maps"
          description="Browse environments."
          actions={<button type="button">Add map</button>}
        />
      </TopBarSlotProvider>,
    );

    expect(screen.getByRole("heading").textContent).toBe("Maps");
    expect(screen.getByTestId("route-context").textContent).toBe("Library");
    expect(screen.getByRole("button", { name: "Add map" }).closest("h1")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("Browse environments.");
    expect(container.querySelector("header")).toBeNull();
  });

  it("renders nothing in the body when there is no description", () => {
    const { container } = renderDom(
      <TopBarSlotProvider>
        <RouteHeaderReadout />
        <PageHeader title="Maps" />
      </TopBarSlotProvider>,
    );

    expect(screen.getByRole("heading").textContent).toBe("Maps");
    expect(container.querySelector("p")).toBeNull();
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
