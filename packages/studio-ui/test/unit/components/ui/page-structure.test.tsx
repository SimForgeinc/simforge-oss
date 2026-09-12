// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { PageHeader } from "../../../../src/components/ui/page-header";
import { Toolbar, ToolbarGroup } from "../../../../src/components/ui/toolbar";
import { EmptyState } from "../../../../src/components/ui/empty-state";

describe("standard page structure", () => {
  it("renders a consistent page title, description, and action zone", () => {
    const html = renderToString(
      <PageHeader title="Maps" description="Browse environments." actions={<button>Add map</button>} />,
    );
    expect(html).toContain("Maps");
    expect(html).toContain("Browse environments.");
    expect(html).toContain("Add map");
  });

  it("renders grouped toolbar controls", () => {
    const html = renderToString(<Toolbar><span>Search</span><ToolbarGroup><button>Sort</button></ToolbarGroup></Toolbar>);
    expect(html).toContain("Search");
    expect(html).toContain("Sort");
  });

  it("renders a task-oriented empty state with an optional action", () => {
    const html = renderToString(<EmptyState title="No maps yet" description="Add your first map." action={<button>Add map</button>} />);
    expect(html).toContain("No maps yet");
    expect(html).toContain("Add your first map.");
    expect(html).toContain("Add map");
  });
});
