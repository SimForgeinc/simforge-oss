import { describe, expect, it } from "vitest";
import {
  parseSelection,
  serializeSelection,
  type EvaluationSelection,
} from "./useEvaluationSelection";

function roundTrip(selection: EvaluationSelection): EvaluationSelection {
  return parseSelection(new URLSearchParams(serializeSelection(selection)));
}

describe("parseSelection", () => {
  it("keeps the compare columns in their baseline order", () => {
    const selection = parseSelection(
      new URLSearchParams("section=campaigns&campaign=c1&mode=compare&policy=b&policy=a&policy=z"),
    );
    expect(selection).toEqual({
      section: "campaigns",
      campaign: "c1",
      compare: ["b", "a", "z"],
    });
    expect(roundTrip(selection)).toEqual(selection);
  });

  it("drops compare mode when only one policy is named", () => {
    expect(parseSelection(new URLSearchParams("section=campaigns&campaign=c1&mode=compare&policy=a")))
      .toEqual({ section: "campaigns", campaign: "c1", policy: "a" });
  });

  it("refuses an episode that names no campaign", () => {
    expect(parseSelection(new URLSearchParams("section=campaigns&episode=e7"))).toEqual({
      section: "campaigns",
    });
  });

  it("opens the runs section for an unknown or missing section", () => {
    expect(parseSelection(new URLSearchParams("section=telemetry&run=job-1"))).toEqual({
      section: "runs",
      run: "job-1",
    });
    expect(parseSelection(new URLSearchParams(""))).toEqual({ section: "runs" });
  });

  it("prefers the cloud run when a local run is also named", () => {
    expect(parseSelection(new URLSearchParams("section=runs&run=job-1&local=run-9"))).toEqual({
      section: "runs",
      run: "job-1",
    });
  });

  it("treats an empty value as no selection", () => {
    expect(parseSelection(new URLSearchParams("section=models&version="))).toEqual({
      section: "models",
    });
  });
});

describe("serializeSelection", () => {
  it("round-trips every section's selection", () => {
    const selections: EvaluationSelection[] = [
      { section: "runs" },
      { section: "runs", run: "job-1" },
      { section: "runs", local: "run-9" },
      { section: "campaigns" },
      { section: "campaigns", campaign: "c1" },
      { section: "campaigns", campaign: "c1", policy: "p1" },
      { section: "campaigns", campaign: "c1", policy: "p1", episode: "e1" },
      { section: "campaigns", campaign: "c1", compare: ["p1", "p2"] },
      { section: "models" },
      { section: "models", version: "v1" },
    ];
    for (const selection of selections) expect(roundTrip(selection)).toEqual(selection);
  });

  it("writes nothing under a campaign section with no campaign", () => {
    expect(serializeSelection({ section: "campaigns", policy: "p1", episode: "e1" })).toBe(
      "section=campaigns",
    );
  });
});
