// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Badge, badgeVariants } from "../../../../src/components/ui/badge";

describe("Badge", () => {
  it("renders children text", () => {
    const html = renderToString(<Badge>Active</Badge>);
    expect(html).toContain("Active");
  });

  it("renders as a div element", () => {
    const html = renderToString(<Badge>Test</Badge>);
    expect(html).toContain("<div");
  });

  it("applies default variant classes when no variant is specified", () => {
    const html = renderToString(<Badge>Default</Badge>);
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
  });

  it("applies secondary variant classes", () => {
    const html = renderToString(<Badge variant="secondary">Secondary</Badge>);
    expect(html).toContain("bg-secondary");
    expect(html).toContain("text-secondary-foreground");
  });

  it("applies destructive variant classes", () => {
    const html = renderToString(<Badge variant="destructive">Error</Badge>);
    expect(html).toContain("bg-destructive");
    expect(html).toContain("text-destructive-foreground");
  });

  it("applies outline variant classes", () => {
    const html = renderToString(<Badge variant="outline">Outline</Badge>);
    expect(html).toContain("text-foreground");
  });

  it("merges a custom className with variant classes", () => {
    const html = renderToString(<Badge className="custom-class">Badge</Badge>);
    expect(html).toContain("custom-class");
  });

  it("passes through arbitrary HTML attributes", () => {
    const html = renderToString(<Badge data-testid="my-badge">Badge</Badge>);
    expect(html).toContain('data-testid="my-badge"');
  });

  it("includes base structural classes on every variant", () => {
    const html = renderToString(<Badge>Base</Badge>);
    expect(html).toContain("inline-flex");
    expect(html).toContain("rounded-md");
    expect(html).toContain("border");
  });
});

describe("badgeVariants", () => {
  it("returns a string containing default variant classes", () => {
    const result = badgeVariants({ variant: "default" });
    expect(typeof result).toBe("string");
    expect(result).toContain("bg-primary");
  });

  it("returns a string containing secondary variant classes", () => {
    const result = badgeVariants({ variant: "secondary" });
    expect(result).toContain("bg-secondary");
  });

  it("returns a string containing destructive variant classes", () => {
    const result = badgeVariants({ variant: "destructive" });
    expect(result).toContain("bg-destructive");
  });

  it("returns a string containing outline variant classes", () => {
    const result = badgeVariants({ variant: "outline" });
    expect(result).toContain("text-foreground");
  });

  it("uses default variant when no variant is passed", () => {
    const result = badgeVariants({});
    expect(result).toContain("bg-primary");
  });
});
