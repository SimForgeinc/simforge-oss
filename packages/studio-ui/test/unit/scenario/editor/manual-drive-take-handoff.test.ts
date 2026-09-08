import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManualDriveRecording, ScenarioTemplateV2 } from "@simforge-oss/scenario";

import {
  ManualDriveTakeDeliveryError,
  deliverManualDriveTakeResult,
  openManualDriveTake,
  readManualDriveTakeRequest,
  readManualDriveTakeResult,
} from "../../../../src/scenario/editor/manual-drive/take-handoff";

/** A localStorage that refuses writes while `full` is set, like a browser at quota. */
function fakeStorage(): Storage & { full: boolean } {
  const items = new Map<string, string>();
  return {
    full: false,
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      if (this.full) throw new DOMException("quota exceeded", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key: string) => { items.delete(key); },
    clear: () => items.clear(),
  };
}

const recording: ManualDriveRecording = {
  version: 1,
  clipSeconds: 20,
  samples: [
    { timeS: 0, x: 1, y: 0, z: 2, headingRad: 0, speedMps: 0 },
    { timeS: 20, x: 1, y: 0, z: 2, headingRad: 0, speedMps: 0 },
  ],
};

function openTake(content: ScenarioTemplateV2) {
  const opened = openManualDriveTake({
    datasetId: "ds",
    documentId: "doc",
    mapVersionId: "map",
    interactionId: "manual_drive_ego",
    actorRoleId: "ego",
    clipSeconds: 20,
    revision: "guard",
    content,
    returnHref: "http://localhost/editor",
  });
  if ("error" in opened) throw new Error(opened.error);
  return opened.takeId;
}

afterEach(() => vi.unstubAllGlobals());

describe("manual drive take delivery", () => {
  it("keeps the take retryable when storage refuses, and delivers it unchanged once storage allows", () => {
    const store = fakeStorage();
    vi.stubGlobal("localStorage", store);
    const takeId = openTake({ big: "x".repeat(1024) } as unknown as ScenarioTemplateV2);

    store.full = true;
    const result = { kind: "saved", recording, revision: "guard", finishedAt: 1 } as const;
    expect(() => deliverManualDriveTakeResult(takeId, result)).toThrow(ManualDriveTakeDeliveryError);
    // Refused: nothing claims to be delivered, and the request is still pending.
    expect(readManualDriveTakeResult(takeId)).toBeNull();
    expect(readManualDriveTakeRequest(takeId)?.takeId).toBe(takeId);

    store.full = false;
    deliverManualDriveTakeResult(takeId, result);
    expect(readManualDriveTakeResult(takeId)).toEqual(result);
  });

  it("frees the consumed document payload to make room for the result before giving up", () => {
    const store = fakeStorage();
    vi.stubGlobal("localStorage", store);
    const takeId = openTake({ big: "x".repeat(1024) } as unknown as ScenarioTemplateV2);

    // Quota that admits the result only once the request no longer carries the document.
    let writes = 0;
    const setItem = store.setItem.bind(store);
    store.setItem = (key, value) => {
      writes += 1;
      if (writes === 1) throw new DOMException("quota exceeded", "QuotaExceededError");
      setItem(key, value);
    };
    const result = { kind: "saved", recording, revision: "guard", finishedAt: 1 } as const;
    deliverManualDriveTakeResult(takeId, result);

    expect(readManualDriveTakeResult(takeId)).toEqual(result);
    const slim = readManualDriveTakeRequest(takeId)!;
    expect(slim.content).toBeUndefined();
    expect(slim).toMatchObject({ takeId, documentId: "doc", interactionId: "manual_drive_ego", actorRoleId: "ego" });
  });
});
