// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Skeleton } from "../../../../src/components/ui/skeleton";

describe("Skeleton", () => {
  it("renders a div element", () => {
    const html = renderToString(<Skeleton />);
    expect(html).toContain("<div");
  });


  it("passes through arbitrary HTML attributes", () => {
    const html = renderToString(<Skeleton data-testid="loading-skeleton" />);
    expect(html).toContain('data-testid="loading-skeleton"');
  });

  it("renders children when provided", () => {
    const html = renderToString(<Skeleton><span>Loading...</span></Skeleton>);
    expect(html).toContain("Loading...");
  });

  it("renders multiple skeletons independently", () => {
    const html = renderToString(
      <div>
        <Skeleton className="h-4" />
        <Skeleton className="h-8" />
      </div>
    );
  });
});
