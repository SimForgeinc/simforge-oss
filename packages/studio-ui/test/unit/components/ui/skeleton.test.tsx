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

  it("applies animate-pulse class", () => {
    const html = renderToString(<Skeleton />);
    expect(html).toContain("animate-pulse");
  });

  it("applies rounded-md class", () => {
    const html = renderToString(<Skeleton />);
    expect(html).toContain("rounded-md");
  });

  it("applies bg-muted class", () => {
    const html = renderToString(<Skeleton />);
    expect(html).toContain("bg-muted");
  });

  it("merges a custom className with base classes", () => {
    const html = renderToString(<Skeleton className="h-4 w-full" />);
    expect(html).toContain("h-4");
    expect(html).toContain("w-full");
    expect(html).toContain("animate-pulse");
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
    expect(html).toContain("h-4");
    expect(html).toContain("h-8");
  });
});
