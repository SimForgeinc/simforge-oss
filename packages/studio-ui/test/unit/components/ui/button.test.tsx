// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Button, buttonVariants } from "../../../../src/components/ui/button";

describe("Button", () => {
  it("renders children text", () => {
    const html = renderToString(<Button>Click me</Button>);
    expect(html).toContain("Click me");
  });

  it("renders as a button element by default", () => {
    const html = renderToString(<Button>Click me</Button>);
    expect(html).toContain("<button");
  });

  it("applies default variant and size classes", () => {
    const html = renderToString(<Button>Default</Button>);
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
    expect(html).toContain("h-10");
    expect(html).toContain("px-4");
  });

  it("applies destructive variant classes", () => {
    const html = renderToString(<Button variant="destructive">Delete</Button>);
    expect(html).toContain("bg-destructive");
    expect(html).toContain("text-destructive-foreground");
  });

  it("applies outline variant classes", () => {
    const html = renderToString(<Button variant="outline">Outline</Button>);
    expect(html).toContain("border");
    expect(html).toContain("bg-background");
  });

  it("applies secondary variant classes", () => {
    const html = renderToString(<Button variant="secondary">Secondary</Button>);
    expect(html).toContain("bg-secondary");
    expect(html).toContain("text-secondary-foreground");
  });

  it("applies ghost variant classes", () => {
    const html = renderToString(<Button variant="ghost">Ghost</Button>);
    expect(html).toContain("hover:bg-accent");
  });

  it("applies link variant classes", () => {
    const html = renderToString(<Button variant="link">Link</Button>);
    expect(html).toContain("text-primary");
    expect(html).toContain("underline-offset-4");
  });

  it("applies sm size classes", () => {
    const html = renderToString(<Button size="sm">Small</Button>);
    expect(html).toContain("h-9");
    expect(html).toContain("px-3");
  });

  it("applies lg size classes", () => {
    const html = renderToString(<Button size="lg">Large</Button>);
    expect(html).toContain("h-11");
    expect(html).toContain("px-6");
  });

  it("applies icon size classes", () => {
    const html = renderToString(<Button size="icon">X</Button>);
    expect(html).toContain("h-10");
    expect(html).toContain("w-10");
  });

  it("renders disabled attribute when disabled prop is passed", () => {
    const html = renderToString(<Button disabled>Disabled</Button>);
    expect(html).toContain("disabled");
  });

  it("applies opacity classes for disabled state", () => {
    const html = renderToString(<Button disabled>Disabled</Button>);
    expect(html).toContain("disabled:opacity-50");
  });

  it("merges a custom className", () => {
    const html = renderToString(<Button className="my-class">Custom</Button>);
    expect(html).toContain("my-class");
  });

  it("passes through arbitrary HTML attributes", () => {
    const html = renderToString(<Button type="submit" data-testid="submit-btn">Submit</Button>);
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-testid="submit-btn"');
  });

  it("renders child element when asChild is true", () => {
    const html = renderToString(
      <Button asChild>
        <a href="/home">Home</a>
      </Button>
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/home"');
    expect(html).toContain("Home");
  });

  it("does not render a button element when asChild is true", () => {
    const html = renderToString(
      <Button asChild>
        <a href="/home">Home</a>
      </Button>
    );
    expect(html).not.toContain("<button");
  });

  it("includes base structural classes on every variant", () => {
    const html = renderToString(<Button>Base</Button>);
    expect(html).toContain("inline-flex");
    expect(html).toContain("items-center");
    expect(html).toContain("rounded-md");
  });
});

describe("buttonVariants", () => {
  it("returns a string for default variant", () => {
    const result = buttonVariants({ variant: "default" });
    expect(typeof result).toBe("string");
    expect(result).toContain("bg-primary");
  });

  it("returns destructive variant classes", () => {
    const result = buttonVariants({ variant: "destructive" });
    expect(result).toContain("bg-destructive");
  });

  it("returns sm size classes", () => {
    const result = buttonVariants({ size: "sm" });
    expect(result).toContain("h-9");
  });

  it("returns lg size classes", () => {
    const result = buttonVariants({ size: "lg" });
    expect(result).toContain("h-11");
  });

  it("returns icon size classes", () => {
    const result = buttonVariants({ size: "icon" });
    expect(result).toContain("w-10");
  });

  it("uses default variant and size when nothing is passed", () => {
    const result = buttonVariants({});
    expect(result).toContain("bg-primary");
    expect(result).toContain("h-10");
  });
});
