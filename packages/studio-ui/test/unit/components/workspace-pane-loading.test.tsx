// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { WorkspacePaneLoading } from "../../../src/components/WorkspacePaneLoading";

describe("WorkspacePaneLoading", () => {
  it("renders the message", () => {
    const html = renderToString(
      <WorkspacePaneLoading message="Loading workspace…" />,
    );
    expect(html).toContain("Loading workspace…");
    expect(html).toContain("workspace-pane-loading");
  });

  it("renders the hint when provided", () => {
    const html = renderToString(
      <WorkspacePaneLoading message="Loading" hint="Fetching artifacts" />,
    );
    expect(html).toContain("Loading");
    expect(html).toContain("Fetching artifacts");
  });


  it("uses role=status for accessibility", () => {
    const html = renderToString(<WorkspacePaneLoading message="Loading" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
  });

});
