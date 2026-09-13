// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Switch } from "../../../../src/components/ui/switch";

function render(element: React.ReactElement): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("expected a rendered element");
  return root;
}

describe("Switch", () => {
  it("renders an unchecked switch button that does not submit forms", () => {
    const root = render(<Switch />);

    expect(root.tagName).toBe("BUTTON");
    expect(root.getAttribute("type")).toBe("button");
    expect(root.getAttribute("role")).toBe("switch");
    expect(root.getAttribute("aria-checked")).toBe("false");
    expect(root.getAttribute("data-state")).toBe("unchecked");
  });

  it("reports the checked state on the root and its thumb", () => {
    const root = render(<Switch defaultChecked />);
    const thumb = root.firstElementChild;

    expect(root.getAttribute("aria-checked")).toBe("true");
    expect(root.getAttribute("data-state")).toBe("checked");
    expect(thumb?.getAttribute("data-state")).toBe("checked");
  });

  it("renders a disabled control when disabled", () => {
    const root = render(<Switch disabled />);

    expect(root.hasAttribute("disabled")).toBe(true);
    expect(root.getAttribute("data-disabled")).toBe("");
    expect(render(<Switch />).hasAttribute("disabled")).toBe(false);
  });

  it("forwards labelling attributes", () => {
    const root = render(<Switch aria-label="Toggle notifications" id="notification-switch" />);

    expect(root.getAttribute("aria-label")).toBe("Toggle notifications");
    expect(root.id).toBe("notification-switch");
  });
});
