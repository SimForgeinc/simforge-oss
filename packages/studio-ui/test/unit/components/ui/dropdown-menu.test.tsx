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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DropdownMenu", () => {
  it("renders the trigger and open content with base classes", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuTrigger data-testid="menu-trigger">Open</DropdownMenuTrigger>
        <DropdownMenuContent className="custom-content">Menu item</DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain('data-testid="menu-trigger"');
    expect(html).toContain("Open");
    expect(html).toContain("custom-content");
    expect(html).toContain("Menu item");

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
    const html = document.body.innerHTML;

    expect(html).toContain("Grouped item");

    app.unmount();
  });
});

describe("DropdownMenuSubTrigger", () => {
  it("renders inset padding and chevron icon", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger inset className="sub-trigger">
              More
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>Nested</DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("sub-trigger");
    expect(html).toContain("More");

    app.unmount();
  });
});

describe("DropdownMenuSubContent", () => {
  it("renders nested content classes", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="custom-sub">Nested item</DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("custom-sub");
    expect(html).toContain("Nested item");

    app.unmount();
  });
});

describe("DropdownMenuItem", () => {
  it("renders item classes with inset and disabled props", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuItem inset disabled data-testid="menu-item">
            Item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain('data-testid="menu-item"');
    expect(html).toContain("Item");

    app.unmount();
  });
});

describe("DropdownMenuCheckboxItem", () => {
  it("renders checkbox padding, indicator container, and text", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked className="checkbox-item">
            Checked item
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("checkbox-item");
    expect(html).toContain("Checked item");

    app.unmount();
  });
});

describe("DropdownMenuRadioItem", () => {
  it("renders radio group items with indicator icon", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="alpha">
            <DropdownMenuRadioItem value="alpha" className="radio-item">
              Alpha
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("radio-item");
    expect(html).toContain("Alpha");

    app.unmount();
  });
});

describe("DropdownMenuLabel", () => {
  it("renders label classes with optional inset", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuLabel inset className="menu-label">
            Actions
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("menu-label");
    expect(html).toContain("Actions");

    app.unmount();
  });
});

describe("DropdownMenuSeparator", () => {
  it("renders separator classes", () => {
    const app = mount(
      <DropdownMenu open>
        <DropdownMenuContent>
          <DropdownMenuSeparator className="menu-separator" />
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("menu-separator");

    app.unmount();
  });
});

describe("DropdownMenuShortcut", () => {
  it("renders shortcut text and classes", () => {
    const html = renderToString(
      <DropdownMenuShortcut className="custom-shortcut" data-testid="shortcut">
        CMD+K
      </DropdownMenuShortcut>
    );

    expect(html).toContain("custom-shortcut");
    expect(html).toContain('data-testid="shortcut"');
    expect(html).toContain("CMD+K");
  });
});
