// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Badge } from "../../../../src/components/ui/badge";

describe("Badge", () => {
  it("renders children text", () => {
    const html = renderToString(<Badge>Active</Badge>);
    expect(html).toContain("Active");
  });

  it("renders as a div element", () => {
    const html = renderToString(<Badge>Test</Badge>);
    expect(html).toContain("<div");
  });


  it("merges a custom className with variant classes", () => {
    const html = renderToString(<Badge className="custom-class">Badge</Badge>);
    expect(html).toContain("custom-class");
  });

  it("passes through arbitrary HTML attributes", () => {
    const html = renderToString(<Badge data-testid="my-badge">Badge</Badge>);
    expect(html).toContain('data-testid="my-badge"');
  });

});

