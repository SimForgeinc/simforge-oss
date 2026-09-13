// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from "../../../../src/components/ui/sheet";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type MountedApp = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mount(element: React.ReactNode): MountedApp {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(element);
  });

  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function query(selector: string): HTMLElement {
  const element = document.body.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`no element matched ${selector}`);
  return element;
}

function classesFor(element: React.ReactNode, selector: string): string[] {
  const app = mount(element);
  const classes = Array.from(query(selector).classList);
  app.unmount();
  return classes;
}

function renderPanel(side?: React.ComponentProps<typeof SheetContent>["side"]): React.ReactElement {
  return (
    <Sheet open>
      <SheetContent side={side}>
        <SheetTitle>Panel</SheetTitle>
        <SheetDescription>Panel description</SheetDescription>
        Body
      </SheetContent>
    </Sheet>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Sheet", () => {
  it("renders trigger and portal children", () => {
    const app = mount(
      <Sheet open>
        <SheetTrigger asChild>
          <button type="button">Open</button>
        </SheetTrigger>
        <SheetPortal>
          <div>Portal content</div>
        </SheetPortal>
      </Sheet>
    );
    const text = document.body.textContent ?? "";

    expect(text).toContain("Open");
    expect(text).toContain("Portal content");

    app.unmount();
  });
});

describe("SheetContent", () => {
  it("renders an accessible dialog labelled by its title and description", () => {
    const app = mount(renderPanel());

    const dialog = query('[role="dialog"]');
    const title = query("h2");
    const description = query("p");

    expect(dialog.getAttribute("data-state")).toBe("open");
    expect(dialog.textContent).toContain("Body");
    expect(title.textContent).toBe("Panel");
    expect(description.textContent).toBe("Panel description");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(description.id);

    app.unmount();
  });

  it("renders a dimming overlay alongside the panel", () => {
    const app = mount(renderPanel());

    const dialog = query('[role="dialog"]');
    const overlay = Array.from(document.body.querySelectorAll('[data-state="open"]')).find(
      (element) => element !== dialog && !dialog.contains(element)
    );

    expect(overlay).toBeDefined();

    app.unmount();
  });

  it("always offers a labelled close affordance", () => {
    const app = mount(renderPanel());

    const closeButtons = Array.from(document.body.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Close")
    );

    expect(closeButtons).toHaveLength(1);

    app.unmount();
  });

  it("styles each side differently", () => {
    const sides = ["top", "bottom", "left", "right"] as const;
    const classesBySide = sides.map((side) => classesFor(renderPanel(side), '[role="dialog"]').join(" "));

    expect(new Set(classesBySide).size).toBe(sides.length);
  });

});

describe("SheetOverlay", () => {
  it("is present only while the sheet is open", () => {
    const open = mount(
      <Sheet open>
        <SheetOverlay data-testid="overlay" />
      </Sheet>
    );

    expect(query('[data-testid="overlay"]').getAttribute("data-state")).toBe("open");

    open.unmount();

    const closed = mount(
      <Sheet>
        <SheetOverlay data-testid="overlay" />
      </Sheet>
    );

    expect(document.body.querySelector('[data-testid="overlay"]')).toBeNull();

    closed.unmount();
  });
});

describe("SheetHeader and SheetFooter", () => {
  it("render divs carrying their children", () => {
    const template = document.createElement("template");

    for (const Section of [SheetHeader, SheetFooter] as const) {
      template.innerHTML = renderToString(<Section>Section body</Section>);
      const plain = template.content.firstElementChild!;

      expect(plain.tagName).toBe("DIV");
      expect(plain.textContent).toBe("Section body");
    }
  });
});

describe("SheetClose", () => {
  it("renders close children when used asChild", () => {
    const app = mount(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Close panel</SheetTitle>
          <SheetDescription>Close description</SheetDescription>
          <SheetClose asChild>
            <button type="button">Dismiss</button>
          </SheetClose>
        </SheetContent>
      </Sheet>
    );

    expect(document.body.textContent).toContain("Dismiss");

    app.unmount();
  });
});
