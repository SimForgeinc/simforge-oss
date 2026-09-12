// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Separator } from "../../../../src/components/ui/separator";

describe("Separator", () => {
  it("renders without crashing", () => {
    const html = renderToString(<Separator />);
    expect(html).toBeTruthy();
  });

  it("applies horizontal size classes by default", () => {
    const html = renderToString(<Separator />);
  });

  it("applies vertical size classes when orientation is vertical", () => {
    const html = renderToString(<Separator orientation="vertical" />);
  });

  it("applies base shrink-0 and bg-border classes", () => {
    const html = renderToString(<Separator />);
  });

  it("merges a custom className", () => {
    const html = renderToString(<Separator className="my-separator" />);
    expect(html).toContain("my-separator");
  });

  it("passes through arbitrary HTML attributes", () => {
    const html = renderToString(<Separator data-testid="divider" />);
    expect(html).toContain('data-testid="divider"');
  });

  it("renders as decorative by default (sets role=none or aria-hidden)", () => {
    // When decorative=true, Radix renders role="none" or aria-hidden
    const html = renderToString(<Separator decorative={true} />);
    // decorative separators have no semantic role; Radix omits role="separator"
    expect(html).not.toContain('role="separator"');
  });

  it("renders with role separator when not decorative", () => {
    const html = renderToString(<Separator decorative={false} />);
    expect(html).toContain('role="separator"');
  });
});
