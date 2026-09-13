// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../../../src/components/ui/dropdown-menu";

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

function query(selector: string, index = 0): HTMLElement {
  const element = document.body.querySelectorAll(selector)[index];
  if (!(element instanceof HTMLElement)) throw new Error(`no element matched ${selector} at ${index}`);
  return element;
}

function classesFor(element: React.ReactNode, selector: string, index = 0): string[] {
  const app = mount(element);
  const classes = Array.from(query(selector, index).classList);
  app.unmount();
  return classes;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DropdownMenu", () => {
  it("renders the trigger and the open menu", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuTrigger data-testid="menu-trigger">Open</DropdownMenuTrigger>
        <DropdownMenuContent>Menu item</DropdownMenuContent>
      </DropdownMenu>
    );

    const trigger = query('[data-testid="menu-trigger"]');
    const menu = query('[role="menu"]');

    expect(trigger.textContent).toBe("Open");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("data-state")).toBe("open");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("data-state")).toBe("open");
    expect(menu.textContent).toContain("Menu item");

    app.unmount();
  });

  it("exports group and portal primitives that render children", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuPortal>
          <DropdownMenuGroup>
            <div>Grouped item</div>
          </DropdownMenuGroup>
        </DropdownMenuPortal>
      </DropdownMenu>
    );

    expect(query('[role="group"]').textContent).toBe("Grouped item");

    app.unmount();
  });
});

describe("DropdownMenuSub", () => {
  it("renders a sub trigger that opens a nested menu", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>Nested item</DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const subTrigger = query('[role="menuitem"][aria-haspopup="menu"]');
    const menus = document.body.querySelectorAll('[role="menu"]');

    expect(subTrigger.textContent).toBe("More");
    expect(subTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(subTrigger.querySelector("svg")).not.toBeNull();
    expect(menus).toHaveLength(2);
    expect(menus[1].textContent).toContain("Nested item");

    app.unmount();
  });

});

describe("DropdownMenuItem", () => {
  it("renders a menu item that reports its disabled state", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem inset disabled data-testid="menu-item">
            Item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const item = query('[role="menuitem"]');

    expect(item.getAttribute("data-testid")).toBe("menu-item");
    expect(item.textContent).toBe("Item");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("data-disabled")).toBe("");

    app.unmount();
  });

  it("indents inset items differently from flush items", () => {
    const flush = classesFor(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
      '[role="menuitem"]'
    );
    const inset = classesFor(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem inset>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
      '[role="menuitem"]'
    );

    expect(inset).not.toEqual(flush);
  });
});

describe("DropdownMenuCheckboxItem", () => {
  it("reports its checked state and shows an indicator only when checked", () => {
    const checkedApp = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked>Checked item</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const checked = query('[role="menuitemcheckbox"]');

    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(checked.getAttribute("data-state")).toBe("checked");
    expect(checked.textContent).toContain("Checked item");
    expect(checked.querySelector("svg")).not.toBeNull();

    checkedApp.unmount();

    const uncheckedApp = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={false}>Unchecked item</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const unchecked = query('[role="menuitemcheckbox"]');

    expect(unchecked.getAttribute("aria-checked")).toBe("false");
    expect(unchecked.getAttribute("data-state")).toBe("unchecked");
    expect(unchecked.querySelector("svg")).toBeNull();

    uncheckedApp.unmount();
  });
});

describe("DropdownMenuRadioItem", () => {
  it("marks only the selected radio item as checked", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="alpha">
            <DropdownMenuRadioItem value="alpha">Alpha</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="beta">Beta</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const [alpha, beta] = Array.from(document.body.querySelectorAll('[role="menuitemradio"]'));

    expect(alpha.getAttribute("aria-checked")).toBe("true");
    expect(alpha.getAttribute("data-state")).toBe("checked");
    expect(alpha.textContent).toContain("Alpha");
    expect(alpha.querySelector("svg")).not.toBeNull();
    expect(beta.getAttribute("aria-checked")).toBe("false");
    expect(beta.querySelector("svg")).toBeNull();

    app.unmount();
  });
});

describe("DropdownMenuLabel", () => {
  it("renders non-interactive label text", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuLabel inset>Actions</DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const menu = query('[role="menu"]');
    const label = menu.firstElementChild;

    expect(label?.textContent).toBe("Actions");
    expect(label?.hasAttribute("role")).toBe(false);

    app.unmount();
  });
});

describe("DropdownMenuSeparator", () => {
  it("renders a horizontal separator", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuSeparator />
        </DropdownMenuContent>
      </DropdownMenu>
    );

    expect(query('[role="separator"]').getAttribute("aria-orientation")).toBe("horizontal");

    app.unmount();
  });
});

describe("DropdownMenuShortcut", () => {
  it("renders shortcut text in a span with forwarded attributes", () => {
    const template = document.createElement("template");
    template.innerHTML = renderToString(
      <DropdownMenuShortcut data-testid="shortcut">CMD+K</DropdownMenuShortcut>
    );
    const shortcut = template.content.firstElementChild!;

    expect(shortcut.tagName).toBe("SPAN");
    expect(shortcut.textContent).toBe("CMD+K");
    expect(shortcut.getAttribute("data-testid")).toBe("shortcut");
  });
});
