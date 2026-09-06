import type { Interaction } from "@simforge-oss/scenario";
import { describe, expect, it } from "vitest";

import {
  interactionIdsThatWouldCycle,
  wouldCycle,
} from "../../../src/lib/scenario/timeline/chains";

/** A `speed` interaction, chained to `after` when given. */
function it_(id: string, after?: string): Interaction {
  return {
    id,
    actor: "challenger",
    verb: "speed",
    target: { mode: "stop" },
    trigger:
      after === undefined
        ? { kind: "at", t: 1 }
        : { kind: "after", of: after, event: "start", delayS: 0 },
  } as Interaction;
}

describe("interactionIdsThatWouldCycle", () => {
  it("finds a direct child", () => {
    const chain = [it_("a"), it_("b", "a")];
    expect([...interactionIdsThatWouldCycle("a", chain)]).toEqual(["b"]);
  });

  it("finds a transitive descendant", () => {
    const chain = [it_("a"), it_("b", "a"), it_("c", "b"), it_("d", "c")];
    expect([...interactionIdsThatWouldCycle("a", chain)].sort()).toEqual(["b", "c", "d"]);
  });

  it("excludes unrelated interactions and siblings", () => {
    const chain = [it_("a"), it_("b", "a"), it_("loner"), it_("other_root"), it_("x", "other_root")];
    expect([...interactionIdsThatWouldCycle("a", chain)]).toEqual(["b"]);
  });

  it("never reports the interaction itself", () => {
    // A self-reference is a different mistake and the model reports it as `self_reference`; listing it
    // here too would put one entry behind two explanations.
    const chain = [it_("a", "a")];
    expect(interactionIdsThatWouldCycle("a", chain).has("a")).toBe(false);
  });

  it("terminates on a pre-existing ring that does not include the subject", () => {
    // The picker still has to render on a document that is already broken elsewhere, so the walk must
    // not hang. Without the `walked` guard this loops forever.
    const chain = [it_("a"), it_("p", "q"), it_("q", "p")];
    expect([...interactionIdsThatWouldCycle("a", chain)]).toEqual([]);
  });

  it("ignores which end of the parent the chain measures from", () => {
    // Waiting for either end of something that is waiting for you is the same deadlock.
    const chain: Interaction[] = [
      it_("a"),
      { ...it_("b", "a"), trigger: { kind: "after", of: "a", event: "end", delayS: 0 } } as Interaction,
    ];
    expect([...interactionIdsThatWouldCycle("a", chain)]).toEqual(["b"]);
  });

  it("is empty when nothing chains at all", () => {
    expect([...interactionIdsThatWouldCycle("a", [it_("a"), it_("b")])]).toEqual([]);
  });
});

describe("wouldCycle", () => {
  it("rejects a self-reference outright", () => {
    expect(wouldCycle("a", "a", [it_("a")])).toBe(true);
  });

  it("rejects a descendant and allows an unrelated root", () => {
    const chain = [it_("a"), it_("b", "a"), it_("loner")];
    expect(wouldCycle("a", "b", chain)).toBe(true);
    expect(wouldCycle("a", "loner", chain)).toBe(false);
  });
});
