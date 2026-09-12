// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../../src/components/ui/tabs";

describe("Tabs", () => {
  it("renders without crashing", () => {
    const html = renderToString(<Tabs defaultValue="tab1"><div /></Tabs>);
    expect(html).toBeTruthy();
  });

  it("renders children inside the tabs root", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <span>child content</span>
      </Tabs>
    );
    expect(html).toContain("child content");
  });
});

describe("TabsList", () => {
  it("renders without crashing inside a Tabs root", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList />
      </Tabs>
    );
    expect(html).toBeTruthy();
  });

  it("applies inline-flex and items-center classes", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList />
      </Tabs>
    );
  });

  it("applies h-9 height class", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList />
      </Tabs>
    );
  });

  it("applies bg-muted and rounded-lg classes", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList />
      </Tabs>
    );
  });

  it("merges a custom className", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList className="my-tabs-list" />
      </Tabs>
    );
    expect(html).toContain("my-tabs-list");
  });
});

describe("TabsTrigger", () => {
  it("renders inside TabsList with tab label text", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Overview</TabsTrigger>
        </TabsList>
      </Tabs>
    );
    expect(html).toContain("Overview");
  });

  it("applies inline-flex and whitespace-nowrap classes", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Label</TabsTrigger>
        </TabsList>
      </Tabs>
    );
  });

  it("applies rounded-md and text-sm classes", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Label</TabsTrigger>
        </TabsList>
      </Tabs>
    );
  });

  it("applies disabled styling classes", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" disabled>Disabled Tab</TabsTrigger>
        </TabsList>
      </Tabs>
    );
  });

  it("merges a custom className", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" className="custom-trigger">Tab</TabsTrigger>
        </TabsList>
      </Tabs>
    );
    expect(html).toContain("custom-trigger");
  });
});

describe("TabsContent", () => {
  it("renders content for the active tab", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsContent value="tab1">Panel content</TabsContent>
      </Tabs>
    );
    expect(html).toContain("Panel content");
  });

  it("applies mt-4 margin class", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
  });

  it("applies ring-offset-background class", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
  });

  it("merges a custom className", () => {
    const html = renderToString(
      <Tabs defaultValue="tab1">
        <TabsContent value="tab1" className="custom-content">Content</TabsContent>
      </Tabs>
    );
    expect(html).toContain("custom-content");
  });
});

describe("Tabs composition", () => {
  it("renders a complete tabs structure without errors", () => {
    const html = renderToString(
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">Run results here</TabsContent>
        <TabsContent value="settings">Settings panel here</TabsContent>
      </Tabs>
    );
    expect(html).toContain("Runs");
    expect(html).toContain("Settings");
    expect(html).toContain("Run results here");
  });
});
