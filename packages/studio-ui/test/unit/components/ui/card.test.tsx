// @vitest-environment jsdom
import * as React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../../src/components/ui/card";

describe("Card", () => {
  it("renders a div with base classes and merged props", () => {
    const html = renderToString(
      <Card className="custom-card" data-testid="card">
        Body
      </Card>
    );

    expect(html).toContain("<div");
    expect(html).toContain("rounded-md");
    expect(html).toContain("border-border");
    expect(html).toContain("bg-card");
    expect(html).toContain("custom-card");
    expect(html).toContain('data-testid="card"');
    expect(html).toContain("Body");
  });
});

describe("CardHeader", () => {
  it("renders header layout classes", () => {
    const html = renderToString(<CardHeader className="header-extra">Header</CardHeader>);

    expect(html).toContain("grid");
    expect(html).toContain("grid-cols-[1fr_auto]");
    expect(html).toContain("gap-y-1.5");
    expect(html).toContain("p-5");
    expect(html).toContain("header-extra");
    expect(html).toContain("Header");
  });
});

describe("CardTitle", () => {
  it("renders title typography classes", () => {
    const html = renderToString(<CardTitle>Title</CardTitle>);

    expect(html).toContain("col-start-1");
    expect(html).toContain("text-[15px]");
    expect(html).toContain("font-semibold");
    expect(html).toContain("tracking-tight");
    expect(html).toContain("Title");
  });
});

describe("CardDescription", () => {
  it("renders description classes and custom className", () => {
    const html = renderToString(
      <CardDescription className="description-extra">Description</CardDescription>
    );

    expect(html).toContain("text-sm");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("description-extra");
    expect(html).toContain("Description");
  });
});

describe("CardAction", () => {
  it("renders action positioning classes", () => {
    const html = renderToString(<CardAction>Action</CardAction>);

    expect(html).toContain("col-start-2");
    expect(html).toContain("row-span-2");
    expect(html).toContain("justify-self-end");
    expect(html).toContain("Action");
  });
});

describe("CardContent", () => {
  it("renders content spacing classes", () => {
    const html = renderToString(<CardContent>Content</CardContent>);

    expect(html).toContain("px-5");
    expect(html).toContain("pb-3");
    expect(html).toContain("Content");
  });
});

describe("CardFooter", () => {
  it("renders footer layout classes", () => {
    const html = renderToString(<CardFooter>Footer</CardFooter>);

    expect(html).toContain("flex");
    expect(html).toContain("items-center");
    expect(html).toContain("border-t");
    expect(html).toContain("p-4");
    expect(html).toContain("px-5");
    expect(html).toContain("Footer");
  });
});
