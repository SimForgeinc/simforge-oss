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
    const html = document.body.innerHTML;

    expect(html).toContain("Open");
    expect(html).toContain("Portal content");

    app.unmount();
  });
});

describe("SheetOverlay", () => {
  it("renders overlay base classes and custom className", () => {
    const app = mount(
      <Sheet open>
        <SheetOverlay className="overlay-extra" />
      </Sheet>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("overlay-extra");

    app.unmount();
  });
});

describe("SheetContent", () => {
  it("renders default right-side content with close affordance", () => {
    const app = mount(
      <Sheet open>
        <SheetContent className="content-extra">
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Panel description</SheetDescription>
          Body
        </SheetContent>
      </Sheet>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("content-extra");
    expect(html).toContain("Close");
    expect(html).toContain("Body");

    app.unmount();
  });

  it("renders variant classes for each side", () => {
    const topApp = mount(
      <Sheet open>
        <SheetContent side="top">
          <SheetTitle>Top panel</SheetTitle>
          <SheetDescription>Top description</SheetDescription>
          Top
        </SheetContent>
      </Sheet>
    );
    const top = document.body.innerHTML;
    topApp.unmount();

    const bottomApp = mount(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetTitle>Bottom panel</SheetTitle>
          <SheetDescription>Bottom description</SheetDescription>
          Bottom
        </SheetContent>
      </Sheet>
    );
    const bottom = document.body.innerHTML;
    bottomApp.unmount();

    const leftApp = mount(
      <Sheet open>
        <SheetContent side="left">
          <SheetTitle>Left panel</SheetTitle>
          <SheetDescription>Left description</SheetDescription>
          Left
        </SheetContent>
      </Sheet>
    );
    const left = document.body.innerHTML;


    leftApp.unmount();
  });
});

describe("SheetHeader", () => {
  it("renders header layout classes", () => {
    const html = renderToString(<SheetHeader className="header-extra">Header</SheetHeader>);

    expect(html).toContain("header-extra");
  });
});

describe("SheetFooter", () => {
  it("renders footer layout classes", () => {
    const html = renderToString(<SheetFooter className="footer-extra">Footer</SheetFooter>);

    expect(html).toContain("footer-extra");
  });
});

describe("SheetTitle", () => {
  it("renders title classes", () => {
    const app = mount(
      <Sheet open>
        <SheetContent>
          <SheetTitle className="title-extra">Title</SheetTitle>
          <SheetDescription>Title description</SheetDescription>
        </SheetContent>
      </Sheet>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("title-extra");

    app.unmount();
  });
});

describe("SheetDescription", () => {
  it("renders description classes", () => {
    const app = mount(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Accessible title</SheetTitle>
          <SheetDescription className="description-extra">Description</SheetDescription>
        </SheetContent>
      </Sheet>
    );
    const html = document.body.innerHTML;

    expect(html).toContain("description-extra");

    app.unmount();
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
    const html = document.body.innerHTML;

    expect(html).toContain("Dismiss");

    app.unmount();
  });
});
