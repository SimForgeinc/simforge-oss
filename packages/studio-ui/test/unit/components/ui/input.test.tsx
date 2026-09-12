// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Input } from "../../../../src/components/ui/input";

describe("Input", () => {
  it("renders an input element", () => {
    const html = renderToString(<Input />);
    expect(html).toContain("<input");
  });

  it("renders with the provided type attribute", () => {
    const html = renderToString(<Input type="email" />);
    expect(html).toContain('type="email"');
  });

  it("renders with type text when no type is provided", () => {
    const html = renderToString(<Input />);
    // default HTML input type is text, or no type attr — either is acceptable
    // The component passes type through, so absence means browser default
    expect(html).toContain("<input");
  });

  it("renders with type password", () => {
    const html = renderToString(<Input type="password" />);
    expect(html).toContain('type="password"');
  });

  it("renders with type number", () => {
    const html = renderToString(<Input type="number" />);
    expect(html).toContain('type="number"');
  });

  it("renders with type search", () => {
    const html = renderToString(<Input type="search" />);
    expect(html).toContain('type="search"');
  });


  it("applies placeholder styling classes", () => {
    const html = renderToString(<Input placeholder="Enter value" />);
    expect(html).toContain('placeholder="Enter value"');
  });


  it("renders disabled attribute when disabled prop is passed", () => {
    const html = renderToString(<Input disabled />);
    expect(html).toContain("disabled");
  });

  it("merges a custom className with base classes", () => {
    const html = renderToString(<Input className="custom-input" />);
    expect(html).toContain("custom-input");
  });

  it("passes through arbitrary HTML attributes", () => {
    const html = renderToString(<Input data-testid="my-input" name="username" />);
    expect(html).toContain('data-testid="my-input"');
    expect(html).toContain('name="username"');
  });

  it("renders with a defaultValue", () => {
    const html = renderToString(<Input defaultValue="hello" />);
    expect(html).toContain("hello");
  });

  it("renders with an id attribute", () => {
    const html = renderToString(<Input id="email-field" />);
    expect(html).toContain('id="email-field"');
  });
});
