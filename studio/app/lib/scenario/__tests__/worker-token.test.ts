import assert from "node:assert/strict";
import { test } from "node:test";

import { expectedScenarioWorkerToken } from "../control-plane-store";

test("a configured token is the token, on every host kind", () => {
  assert.equal(expectedScenarioWorkerToken({ SIMFORGE_RENDER_WORKER_TOKEN: " wk_secret " }), "wk_secret");
  assert.equal(
    expectedScenarioWorkerToken({ SIMFORGE_RENDER_WORKER_TOKEN: "wk_secret", SIMFORGE_LOCAL_OPEN_ACCESS: "1" }),
    "wk_secret",
  );
});

test("the development token is only offered by the open-access host", () => {
  assert.equal(expectedScenarioWorkerToken({ SIMFORGE_LOCAL_OPEN_ACCESS: "1" }), "simforge-local-worker");
});

test("a supervised or hosted deployment without a token admits no worker", () => {
  assert.equal(expectedScenarioWorkerToken({}), null);
  assert.equal(expectedScenarioWorkerToken({ SIMFORGE_RENDER_WORKER_TOKEN: "  " }), null);
  assert.equal(expectedScenarioWorkerToken({ SIMFORGE_LOCAL_OPEN_ACCESS: "0" }), null);
});
