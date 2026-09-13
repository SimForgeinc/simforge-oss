// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Separator } from "../../../../src/components/ui/separator";

function render(element: React.ReactElement): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("expected a rendered element");
  return root;
}

describe("Separator", () => {
  it("is horizontal and decorative by default", () => {
    const separator = render(<Separator />);

    expect(separator.getAttribute("data-orientation")).toBe("horizontal");
    expect(separator.getAttribute("role")).toBe("none");
  });

  it("reports a vertical orientation when asked for one", () => {
    expect(render(<Separator orientation="vertical" />).getAttribute("data-orientation")).toBe("vertical");
  });

  it("styles itself differently per orientation", () => {
    const horizontal = Array.from(render(<Separator />).classList);
    const vertical = Array.from(render(<Separator orientation="vertical" />).classList);

    expect(vertical).not.toEqual(horizontal);
  });

  it("exposes separator semantics when it is not decorative", () => {
    const horizontal = render(<Separator decorative={false} />);
    const vertical = render(<Separator decorative={false} orientation="vertical" />);

    expect(horizontal.getAttribute("role")).toBe("separator");
    expect(horizontal.getAttribute("aria-orientation")).toBeNull();
    expect(vertical.getAttribute("role")).toBe("separator");
    expect(vertical.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("forwards arbitrary DOM attributes", () => {
    expect(render(<Separator data-testid="divider" />).getAttribute("data-testid")).toBe("divider");
  });
});
