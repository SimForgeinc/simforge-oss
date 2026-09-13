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

function render(element: React.ReactElement): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  return template.content;
}

function renderTooltip(contentProps: React.ComponentProps<typeof TooltipContent> = {}): DocumentFragment {
  return render(
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger>Trigger</TooltipTrigger>
        <TooltipContent {...contentProps}>Copy to clipboard</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe("TooltipTrigger", () => {
  it("renders a trigger button with its children and forwarded attributes", () => {
    const trigger = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger data-testid="tooltip-trigger">Hover me</TooltipTrigger>
        </Tooltip>
      </TooltipProvider>,
    ).querySelector("button")!;

    expect(trigger.textContent).toBe("Hover me");
    expect(trigger.getAttribute("data-testid")).toBe("tooltip-trigger");
    expect(trigger.getAttribute("data-state")).toBe("closed");
  });

  it("is not described by a tooltip while the tooltip is closed", () => {
    const fragment = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Help text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(fragment.querySelector("button")?.getAttribute("aria-describedby")).toBeNull();
    expect(fragment.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("TooltipContent", () => {
  it("renders the tooltip text with tooltip semantics when open", () => {
    const content = renderTooltip().querySelector('[role="tooltip"]')!;

    expect(content.textContent).toBe("Copy to clipboard");
  });

  it("describes its trigger while open", () => {
    const fragment = renderTooltip();
    const trigger = fragment.querySelector("button")!;
    const content = fragment.querySelector('[role="tooltip"]')!;

    expect(content.id).not.toBe("");
    expect(trigger.getAttribute("aria-describedby")).toBe(content.id);
  });
});
