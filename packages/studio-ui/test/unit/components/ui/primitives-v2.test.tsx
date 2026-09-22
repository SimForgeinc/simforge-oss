// @vitest-environment jsdom
import * as React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { Chip, ChipButton } from "../../../../src/components/ui/chip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../src/components/ui/dialog";
import { Dot } from "../../../../src/components/ui/dot";
import { IconButton } from "../../../../src/components/ui/icon-button";
import { Spinner } from "../../../../src/components/ui/spinner";

describe("round primitives", () => {
  it("Spinner opts out of the square reset and announces itself", () => {
    const html = renderToString(<Spinner label="Loading maps" />);
    expect(html).toContain('data-shape="round"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading maps"');
  });

  it("Spinner with a visible caption is hidden from assistive technology", () => {
    const html = renderToString(<Spinner label={null} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="status"');
  });

  it("Dot is decorative unless labelled", () => {
    expect(renderToString(<Dot tone="positive" />)).toContain('aria-hidden="true"');
    expect(renderToString(<Dot tone="critical" label="Failed" />)).toContain('aria-label="Failed"');
  });
});

describe("IconButton", () => {
  it("requires and renders an accessible name and a pressed state", () => {
    const html = renderToString(<IconButton label="Close" active={false}><svg /></IconButton>);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('type="button"');
  });
});

describe("Chip", () => {
  it("renders a label and a toggle", () => {
    expect(renderToString(<Chip tone="warning">Stale</Chip>)).toContain("Stale");
    expect(renderToString(<ChipButton selected>Mine</ChipButton>)).toContain('aria-pressed="true"');
  });
});

describe("Dialog", () => {
  it("renders title, description and a close button in a portal", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename dataset</DialogTitle>
            <DialogDescription>Visible to the workspace.</DialogDescription>
          </DialogHeader>
          <DialogFooter>footer</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Rename dataset");
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.querySelector('[aria-label="Close"]')).not.toBeNull();
  });
});
