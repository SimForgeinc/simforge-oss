// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Button } from "../../../../src/components/ui/button";

describe("Button", () => {
  it("renders children text", () => {
    const html = renderToString(<Button>Click me</Button>);
    expect(html).toContain("Click me");
  });

  it("renders as a button element by default", () => {
    const html = renderToString(<Button>Click me</Button>);
    expect(html).toContain("<button");
  });


  it("renders disabled attribute when disabled prop is passed", () => {
    const html = renderToString(<Button disabled>Disabled</Button>);
    expect(html).toContain("disabled");
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

});

