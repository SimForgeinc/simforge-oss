import assert from "node:assert/strict";
import { test } from "node:test";
import { recordedStepAt, type RecordedStep } from "../run-viewer-contract";

test("a solo-video prologue has no policy HUD; policy frames use recorded time and hold the terminal decision", () => {
  const steps: RecordedStep[] = [{ step: 0, tS: 6.4 }, { step: 1, tS: 6.5 }, { step: 2, tS: 6.8 }];
  const prologueS = 6.4;
  assert.equal(recordedStepAt(steps, 1.5 - prologueS), null);
  assert.equal(recordedStepAt(steps, 6.4 - prologueS)?.step, 0);
  assert.equal(recordedStepAt(steps, 6.79 - prologueS)?.step, 1);
  assert.equal(recordedStepAt(steps, 6.8 - prologueS)?.step, 2);
  assert.equal(recordedStepAt(steps, 25 - prologueS)?.step, 2);
});
