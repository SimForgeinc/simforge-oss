// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Switch } from "../../../../src/components/ui/switch";

describe("Switch", () => {
  it("renders without crashing", () => {
    const html = renderToString(<Switch />);
    expect(html).toBeTruthy();
  });

  it("renders a button element (Radix Switch root is a button)", () => {
    const html = renderToString(<Switch />);
    expect(html).toContain("<button");
  });

  it("applies peer class for Tailwind peer selectors", () => {
    const html = renderToString(<Switch />);
    expect(html).toContain("peer");
  });

  it("applies base sizing classes", () => {
    const html = renderToString(<Switch />);
    expect(html).toContain("h-4");
    expect(html).toContain("w-7");
  });

  it("applies rounded-full class", () => {
    const html = renderToString(<Switch />);
    expect(html).toContain("rounded-full");
  });

  it("applies disabled styling classes", () => {
    const html = renderToString(<Switch disabled />);
    expect(html).toContain("disabled:cursor-not-allowed");
    expect(html).toContain("disabled:opacity-50");
  });

  it("renders disabled attribute when disabled prop is passed", () => {
    const html = renderToString(<Switch disabled />);
    expect(html).toContain("disabled");
  });

  it("merges a custom className with base classes", () => {
    const html = renderToString(<Switch className="my-switch" />);
    expect(html).toContain("my-switch");
    expect(html).toContain("rounded-full");
  });

  it("renders the thumb span inside the root", () => {
    const html = renderToString(<Switch />);
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("rounded-full");
    expect(html).toContain("bg-background");
  });

  it("passes through aria-label attribute", () => {
    const html = renderToString(<Switch aria-label="Toggle notifications" />);
    expect(html).toContain('aria-label="Toggle notifications"');
  });

  it("passes through id attribute", () => {
    const html = renderToString(<Switch id="notification-switch" />);
    expect(html).toContain('id="notification-switch"');
  });
});
