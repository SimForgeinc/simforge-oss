import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SIMFORGE_ENV = "dev";

import { z } from "zod";
import { parseEvidenceTolerant } from "../render-worker-control-store";

test("completion evidence ignores fields a newer worker added but keeps known fields strict", () => {
  const schema = z.strictObject({ intentSha256: z.string().regex(/^[a-f0-9]{64}$/), frameCount: z.number().int() });
  assert.deepEqual(parseEvidenceTolerant(schema, { intentSha256: "a".repeat(64), frameCount: 3, futureField: { x: 1 } }), { intentSha256: "a".repeat(64), frameCount: 3 });
  assert.throws(() => parseEvidenceTolerant(schema, { intentSha256: "not-a-digest", frameCount: 3, futureField: 1 }));
  assert.throws(() => parseEvidenceTolerant(schema, { frameCount: 3 }));
});
