// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Input } from "../../../../src/components/ui/input";

function render(element: React.ReactElement): HTMLInputElement {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLInputElement)) throw new Error("expected an input element");
  return root;
}

describe("Input", () => {
  it("renders an input that behaves as a text field when no type is given", () => {
    const input = render(<Input />);

    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("text");
  });

  it("renders the requested input type", () => {
    for (const type of ["email", "password", "number", "search"] as const) {
      expect(render(<Input type={type} />).type, type).toBe(type);
    }
  });

  it("renders the placeholder text", () => {
    expect(render(<Input placeholder="Enter value" />).placeholder).toBe("Enter value");
  });

  it("renders a disabled control when disabled", () => {
    expect(render(<Input disabled />).disabled).toBe(true);
    expect(render(<Input />).disabled).toBe(false);
  });

  it("keeps a caller-supplied inline style", () => {
    expect(render(<Input style={{ marginTop: 4 }} />).style.marginTop).toBe("4px");
  });

  it("forwards arbitrary DOM attributes", () => {
    const input = render(<Input data-testid="my-input" name="username" id="email-field" />);

    expect(input.getAttribute("data-testid")).toBe("my-input");
    expect(input.name).toBe("username");
    expect(input.id).toBe("email-field");
  });

  it("renders its default value", () => {
    expect(render(<Input defaultValue="hello" />).getAttribute("value")).toBe("hello");
  });
});
