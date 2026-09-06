// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "../../../../src/components/ui/tooltip";

describe("TooltipProvider", () => {
  it("renders children without crashing", () => {
    const html = renderToString(
      <TooltipProvider>
        <span>child</span>
      </TooltipProvider>
    );
    expect(html).toContain("child");
  });
});

describe("Tooltip", () => {
  it("renders children inside the tooltip root", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip>
          <span>tooltip root</span>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain("tooltip root");
  });
});

describe("TooltipTrigger", () => {
  it("renders the trigger element with its children", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <button type="button">Hover me</button>
          </TooltipTrigger>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain("Hover me");
  });

  it("passes through HTML attributes to the trigger", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger data-testid="tooltip-trigger">Trigger</TooltipTrigger>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain('data-testid="tooltip-trigger"');
  });
});

describe("TooltipContent", () => {
  it("applies z-50 and overflow-hidden classes", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Tooltip text</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain("z-50");
    expect(html).toContain("overflow-hidden");
  });

  it("applies rounded-md and border classes", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Tooltip text</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain("rounded-md");
    expect(html).toContain("border");
  });

  it("applies bg-popover and text-popover-foreground classes", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Tooltip text</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain("bg-popover");
    expect(html).toContain("text-popover-foreground");
  });

  it("renders tooltip text content", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Copy to clipboard</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain("Copy to clipboard");
  });

  it("merges a custom className", () => {
    const html = renderToString(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent className="custom-tooltip">Help text</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(html).toContain("custom-tooltip");
  });
});
