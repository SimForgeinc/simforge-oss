// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../../src/components/ui/tabs";

function render(element: React.ReactElement): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  return template.content;
}

function renderTabs(listProps: React.ComponentProps<typeof TabsList> = {}): DocumentFragment {
  return render(
    <Tabs defaultValue="runs">
      <TabsList {...listProps}>
        <TabsTrigger value="runs">Runs</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="runs">Run results here</TabsContent>
      <TabsContent value="settings">Settings panel here</TabsContent>
    </Tabs>,
  );
}

describe("Tabs", () => {
  it("renders arbitrary children inside the root", () => {
    expect(render(
      <Tabs defaultValue="tab1">
        <span>child content</span>
      </Tabs>,
    ).textContent).toContain("child content");
  });

  it("exposes tablist, tab and tabpanel roles", () => {
    const fragment = renderTabs();

    expect(fragment.querySelector('[role="tablist"]')).not.toBeNull();
    expect(Array.from(fragment.querySelectorAll('[role="tab"]'), (tab) => tab.textContent)).toEqual([
      "Runs",
      "Settings",
    ]);
    expect(fragment.querySelector('[role="tabpanel"]')?.textContent).toBe("Run results here");
  });

  it("marks only the default tab as selected", () => {
    const [runs, settings] = Array.from(renderTabs().querySelectorAll('[role="tab"]'));

    expect(runs.getAttribute("aria-selected")).toBe("true");
    expect(runs.getAttribute("data-state")).toBe("active");
    expect(settings.getAttribute("aria-selected")).toBe("false");
    expect(settings.getAttribute("data-state")).toBe("inactive");
  });

  it("shows only the active panel and links it to its trigger", () => {
    const fragment = renderTabs();
    const [active, inactive] = Array.from(fragment.querySelectorAll('[role="tabpanel"]'));
    const activeTrigger = fragment.querySelector('[role="tab"][data-state="active"]')!;

    expect(active.hasAttribute("hidden")).toBe(false);
    expect(active.getAttribute("aria-labelledby")).toBe(activeTrigger.id);
    expect(activeTrigger.getAttribute("aria-controls")).toBe(active.id);
    expect(inactive.getAttribute("data-state")).toBe("inactive");
    expect(inactive.hasAttribute("hidden")).toBe(true);
  });

  it("renders a disabled trigger as a disabled control", () => {
    const trigger = render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" disabled>
            Disabled Tab
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    ).querySelector('[role="tab"]')!;

    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("data-disabled")).toBe("");
  });

  it("keeps their own styling when the caller adds a className", () => {
    const plain = renderTabs();
    const customised = render(
      <Tabs defaultValue="runs">
        <TabsList className="my-tabs-list">
          <TabsTrigger value="runs" className="custom-trigger">
            Runs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="custom-content">
          Run results here
        </TabsContent>
      </Tabs>,
    );

    const selectors: ReadonlyArray<readonly [string, string]> = [
      ['[role="tablist"]', "my-tabs-list"],
      ['[role="tab"]', "custom-trigger"],
      ['[role="tabpanel"]', "custom-content"],
    ];

    for (const [selector, customClass] of selectors) {
      const own = Array.from(plain.querySelector(selector)!.classList);
      const merged = Array.from(customised.querySelector(selector)!.classList);

      expect(merged, selector).toEqual(expect.arrayContaining([...own, customClass]));
    }
  });
});
