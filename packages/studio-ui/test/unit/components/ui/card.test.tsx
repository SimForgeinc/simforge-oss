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

function render(element: React.ReactElement): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = renderToString(element);
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error("expected a rendered element");
  return root;
}

const parts: ReadonlyArray<readonly [string, React.ElementType<React.HTMLAttributes<HTMLDivElement>>]> = [
  ["Card", Card],
  ["CardHeader", CardHeader],
  ["CardTitle", CardTitle],
  ["CardDescription", CardDescription],
  ["CardAction", CardAction],
  ["CardContent", CardContent],
  ["CardFooter", CardFooter],
];

describe("Card parts", () => {
  it("each render a div carrying their children", () => {
    for (const [name, Part] of parts) {
      const element = render(<Part>{name} body</Part>);

      expect(element.tagName, name).toBe("DIV");
      expect(element.textContent, name).toBe(`${name} body`);
    }
  });

});

describe("Card", () => {
  it("forwards arbitrary DOM attributes", () => {
    const card = render(
      <Card data-testid="card" id="summary" aria-label="Summary card">
        Body
      </Card>
    );

    expect(card.getAttribute("data-testid")).toBe("card");
    expect(card.getAttribute("id")).toBe("summary");
    expect(card.getAttribute("aria-label")).toBe("Summary card");
  });

  it("keeps a caller-supplied inline style", () => {
    const card = render(<Card style={{ marginTop: 4 }} />);

    expect(card.style.marginTop).toBe("4px");
  });

  it("composes header, content and footer in document order", () => {
    const card = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
          <CardAction>
            <button type="button">Act</button>
          </CardAction>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );

    const [header, content, footer] = Array.from(card.children);

    expect(header.textContent).toBe("TitleDescriptionAct");
    expect(content.textContent).toBe("Content");
    expect(footer.textContent).toBe("Footer");
    expect(header.querySelector("button")?.textContent).toBe("Act");
  });
});
