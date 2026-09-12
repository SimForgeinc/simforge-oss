// @vitest-environment jsdom
import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CloudActivityIndicator,
  CloudLoadingSurface,
} from "../../../src/components/CloudLoadingSurface";

describe("CloudLoadingSurface", () => {
  it("announces screen loading and indeterminate progress", () => {
    const html = renderToString(
      <CloudLoadingSurface
        detail="Opening the scenario workspace."
        progress={null}
        scope="screen"
        title="Loading your scenarios…"
      />,
    );

    expect(html).toContain('data-cloud-loading-scope="screen"');
    expect(html).toContain("Loading your scenarios");
    expect(html).toContain('role="progressbar"');
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
  it("announces activity status", () => {
    const html = renderToString(<CloudActivityIndicator label="Saving rating" />);

    expect(html).toContain('role="status"');
    expect(html).toContain("Saving rating");
  });
});
