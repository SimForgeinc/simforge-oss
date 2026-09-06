// @vitest-environment jsdom
import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CloudActivityIndicator,
  CloudLoadingSurface,
} from "../../../src/components/CloudLoadingSurface";

describe("CloudLoadingSurface", () => {
  it("renders a flat full-screen cloud blocker", () => {
    const html = renderToString(
      <CloudLoadingSurface
        detail="Opening the scenario workspace."
        progress={null}
        scope="screen"
        title="Loading your scenarios…"
      />,
    );

    expect(html).toContain('data-cloud-loading-scope="screen"');
    expect(html).toContain("fixed inset-0");
    expect(html).toContain("Loading your scenarios");
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain("bg-card");
    expect(html).not.toContain("shadow-lg");
  });

  it("uses the lightweight cloud field for a contained pane", () => {
    const html = renderToString(
      <CloudLoadingSurface scope="pane" title="Loading renders…" />,
    );

    expect(html).toContain('data-cloud-loading-scope="pane"');
    expect(html).toContain("app-topbar-clouds");
    expect(html).not.toContain("app-switcher-three-sky");
  });

  it("normalizes progress and shows transfer telemetry", () => {
    const html = renderToString(
      <CloudLoadingSurface
        progress={104.4}
        telemetry={{
          transferred: "18 MB",
          total: "40 MB",
          speed: "8 MB/s",
          eta: "3 sec",
        }}
        title="Preparing maps"
      />,
    );

    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("18 MB");
    expect(html).toContain("40 MB");
    expect(html).toContain("8 MB/s");
    expect(html).toContain("3 sec");
    expect(html).toContain("remaining");
  });
});

describe("CloudActivityIndicator", () => {
  it("uses the shared activity treatment without creating a blocking surface", () => {
    const html = renderToString(<CloudActivityIndicator label="Saving rating" />);

    expect(html).toContain('role="status"');
    expect(html).toContain("Saving rating");
    expect(html).toContain("text-[#E8E044]");
    expect(html).not.toContain("fixed inset-0");
  });
});
