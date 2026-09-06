/** @vitest-environment jsdom */

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TriggerSchema,
  type Interaction,
  type Trigger,
} from "@simforge-oss/scenario";
import type { EditorDocument } from "@simforge-oss/editor";
import { TriggerControls } from "../../../src/scenario/editor/timeline/TriggerControls";

afterEach(cleanup);

const roles = [
  { id: "ego", label: "Ego" },
  { id: "challenger", label: "Challenger" },
];
const prior: Interaction = {
  id: "prior_action",
  actor: "challenger",
  trigger: { kind: "at", t: 0 },
  verb: "exist",
  target: { state: "present" },
};

function renderTrigger(initial: Trigger) {
  const commits: Trigger[] = [];
  const onCommit = vi.fn((value: Trigger) => commits.push(value));
  function Harness() {
    const [value, setValue] = useState<Trigger>(initial);
    return (
      <TriggerControls
        actorId="ego"
        document={{ data: { roles } } as unknown as EditorDocument}
        interactionId="edited_action"
        interactions={[prior]}
        label="Starts"
        value={value}
        onChange={(next) => {
          if (!next) return;
          onCommit(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { commits, onCommit };
}

function choose(label: string, option: string) {
  fireEvent.pointerDown(screen.getByLabelText(label), { button: 0 });
  fireEvent.click(screen.getByRole("menuitemradio", { name: option }));
}

describe("TriggerControls", () => {
  it("authors after-start and after-end references", () => {
    const { commits } = renderTrigger({
      kind: "after",
      of: "prior_action",
      event: "start",
      delayS: 0,
    });
    choose("Referenced event", "Action end");
    expect(commits.at(-1)).toEqual({
      kind: "after",
      of: "prior_action",
      event: "end",
      delayS: 0,
    });
  });

  it("authors role, feature, and route-pose arrival points", () => {
    const { commits } = renderTrigger({
      kind: "arrival",
      of: "ego",
      at: { role: "challenger" },
      syncWith: "challenger",
      deltaT: 0,
    });
    choose("Reference type", "Map feature");
    fireEvent.change(screen.getByLabelText("Feature id"), {
      target: { value: "junction_entry" },
    });
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      kind: "arrival",
      at: { feature: "junction_entry", at: "entry" },
    }));

    choose("Reference type", "Route pose");
    fireEvent.change(screen.getByLabelText("Longitudinal s"), {
      target: { value: "25" },
    });
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      kind: "arrival",
      at: { pose: expect.objectContaining({ s: 25 }) },
    }));
  });

  it("edits distance mode, hysteresis, hidden visibility, and detection", () => {
    const { commits } = renderTrigger({
      kind: "when",
      condition: {
        kind: "distance",
        from: "ego",
        to: { role: "challenger" },
        measure: "alongLane",
        op: "<=",
        valueM: 10,
      },
      byLatest: 20,
      ifNever: "skip",
    });
    choose("Distance measure", "Euclidean");
    fireEvent.change(screen.getByLabelText("Hysteresis (m)"), {
      target: { value: "1.5" },
    });
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      condition: expect.objectContaining({
        kind: "distance",
        measure: "euclidean",
        hysteresisM: 1.5,
      }),
    }));

    choose("Condition type", "visible");
    choose("Visibility state", "Not visible");
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      condition: expect.objectContaining({ kind: "visible", visible: false }),
    }));

    choose("Condition type", "detected");
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      condition: { kind: "detected", of: "challenger", by: "ego", detected: true },
    }));
  });

  it("authors all signal references and recursively edits logical leaves", () => {
    const { commits } = renderTrigger({
      kind: "when",
      condition: {
        kind: "signal",
        signal: { control: "signal-1" },
        phase: "green",
      },
      byLatest: 20,
      ifNever: "skip",
    });
    choose("Reference type", "Signal handle");
    fireEvent.change(screen.getByLabelText("Signal handle"), {
      target: { value: "main-signal" },
    });
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      condition: expect.objectContaining({ signal: { handle: "main-signal" } }),
    }));

    choose("Reference type", "Map feature");
    choose("Approach", "opposing");
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      condition: expect.objectContaining({
        signal: { feature: "feature", approach: "opposing" },
      }),
    }));

    choose("Condition type", "and");
    choose("Condition 1 type", "detected");
    fireEvent.change(screen.getByLabelText("Sensor (optional)"), {
      target: { value: "front-radar" },
    });
    const logical = commits.at(-1);
    expect(logical).toEqual(expect.objectContaining({
      condition: expect.objectContaining({
        kind: "and",
        operands: expect.arrayContaining([
          expect.objectContaining({ kind: "detected", sensor: "front-radar" }),
        ]),
      }),
    }));
    expect(commits.every((trigger) => TriggerSchema.safeParse(trigger).success)).toBe(true);
  });

  it("keeps and, or, and not leaves independently editable", () => {
    const { commits } = renderTrigger({
      kind: "when",
      condition: { kind: "speed", of: "ego", op: ">=", valueKph: 20 },
      byLatest: 20,
      ifNever: "skip",
    });

    choose("Condition type", "or");
    choose("Condition 2 type", "detected");
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      condition: expect.objectContaining({
        kind: "or",
        operands: expect.arrayContaining([
          expect.objectContaining({ kind: "detected" }),
        ]),
      }),
    }));

    choose("Condition type", "not");
    choose("Negated condition type", "visible");
    choose("Visibility state", "Not visible");
    expect(commits.at(-1)).toEqual(expect.objectContaining({
      condition: {
        kind: "not",
        operand: expect.objectContaining({ kind: "visible", visible: false }),
      },
    }));
    expect(commits.every((trigger) => TriggerSchema.safeParse(trigger).success)).toBe(true);
  });
});
