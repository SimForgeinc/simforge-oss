// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requestedDriveMapId, useRequestedMapOpen } from "./drive-map-request";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Attempt = { mapVersionId: string; signal: AbortSignal };

function Harness({ takeMapId, urlMapId, activeMapVersionId, attempts }: {
  takeMapId: string | null;
  urlMapId: string | null;
  activeMapVersionId: string | null;
  attempts: Attempt[];
}) {
  useRequestedMapOpen({
    requestedMapId: requestedDriveMapId(takeMapId, urlMapId),
    activeMapVersionId,
    suspended: false,
    open: async (mapVersionId, signal) => {
      attempts.push({ mapVersionId, signal });
    },
  });
  return null;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(props: Omit<Parameters<typeof Harness>[0], "attempts">, attempts: Attempt[]) {
  act(() => root.render(<Harness {...props} attempts={attempts} />));
}

describe("Drive requested-map opening", () => {
  it("opens the take's map when the take session resolves after the first render", () => {
    const attempts: Attempt[] = [];
    // Server render / first client render: no take yet, no deep link.
    render({ takeMapId: null, urlMapId: null, activeMapVersionId: null }, attempts);
    expect(attempts).toEqual([]);
    // The handoff mailbox resolves from storage after hydration.
    render({ takeMapId: "mv_take", urlMapId: null, activeMapVersionId: null }, attempts);
    expect(attempts.map((attempt) => attempt.mapVersionId)).toEqual(["mv_take"]);
    // While the open is in flight nothing cancels it.
    expect(attempts[0]!.signal.aborted).toBe(false);
    // Once that map is active nothing re-opens it.
    render({ takeMapId: "mv_take", urlMapId: null, activeMapVersionId: "mv_take" }, attempts);
    expect(attempts).toHaveLength(1);
  });

  it("aborts a stale open when the requested id changes, and the take outranks the deep link", () => {
    const attempts: Attempt[] = [];
    render({ takeMapId: null, urlMapId: "mv_url", activeMapVersionId: null }, attempts);
    expect(attempts.map((attempt) => attempt.mapVersionId)).toEqual(["mv_url"]);
    render({ takeMapId: "mv_take", urlMapId: "mv_url", activeMapVersionId: null }, attempts);
    expect(attempts.map((attempt) => attempt.mapVersionId)).toEqual(["mv_url", "mv_take"]);
    expect(attempts[0]!.signal.aborted).toBe(true);
    expect(attempts[1]!.signal.aborted).toBe(false);
  });
});
