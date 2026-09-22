// @vitest-environment jsdom
import * as React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { TemplatePanel } from "../../../src/components/template/TemplatePanel";

describe("TemplatePanel (the component template)", () => {
  it("renders its header, rows and row actions from primitives and recipes", () => {
    const html = renderToString(
      <TemplatePanel
        title="Runs"
        items={[
          { id: "a", name: "Left turn", detail: "12 s", status: "ready" },
          { id: "b", name: "Merge", detail: "running", status: "running" },
        ]}
        selectedId="a"
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(html).toContain("Runs");
    expect(html).toMatch(/2(<!-- -->)? items/);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-label="More actions for Merge"');
    expect(html).toContain('data-shape="round"');
    expect(html).not.toContain("style=");
  });
});
