import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SqlParams } from "@/app/lib/db/data-api";
import { readRenderIntentText } from "../render-worker-control-store";

/**
 * A stand-in for `render_jobs` that answers the two statements the reader
 * issues with Postgres semantics: `length()` and `substr()` count code points
 * and `substr` is 1-based. It records each call so the test can prove the
 * intent was fetched in bounded slices rather than one oversized response.
 */
function fakeRenderJobs(intents: Record<string, string>, options: { truncateSlices?: boolean } = {}) {
  const calls: SqlParams[] = [];
  const query = async <T>(sql: string, params: SqlParams = {}): Promise<T[]> => {
    calls.push(params);
    const text = intents[String(params.job_id)];
    if (text === undefined) return [];
    const points = Array.from(text);
    const start = Number(params.start ?? 1);
    const size = Number(params.size);
    let part = points.slice(start - 1, start - 1 + size).join("");
    if (options.truncateSlices && start > 1) part = part.slice(0, -1);
    const row = sql.includes("length(render_intent::text)")
      ? { chars: String(points.length), part }
      : { part };
    return [row as T];
  };
  return { query, calls };
}

test("an intent larger than one slice is reassembled from bounded reads", async () => {
  const intent = JSON.stringify({ assets: Array.from({ length: 400 }, (_, i) => ({ assetId: `map.resource.${i}` })) });
  const { query, calls } = fakeRenderJobs({ usrj_big: intent });
  const text = await readRenderIntentText(query, "usrj_big", 1_000);
  assert.equal(text, intent);
  assert.equal(calls.length, Math.ceil(intent.length / 1_000));
  for (const call of calls) assert.equal(call.size, 1_000);
});

test("an intent that fits one slice costs one statement", async () => {
  const { query, calls } = fakeRenderJobs({ usrj_small: "{\"schema\":\"x\"}" });
  assert.equal(await readRenderIntentText(query, "usrj_small"), "{\"schema\":\"x\"}");
  assert.equal(calls.length, 1);
});

test("slices split on code points, not UTF-16 units", async () => {
  const intent = `{"label":"${"🚗é".repeat(50)}"}`;
  const { query } = fakeRenderJobs({ usrj_emoji: intent });
  assert.equal(await readRenderIntentText(query, "usrj_emoji", 7), intent);
});

test("a missing job resolves null and a short read fails closed", async () => {
  const { query } = fakeRenderJobs({});
  assert.equal(await readRenderIntentText(query, "usrj_missing"), null);
  const truncated = fakeRenderJobs({ usrj_torn: "x".repeat(50) }, { truncateSlices: true });
  await assert.rejects(readRenderIntentText(truncated.query, "usrj_torn", 10), /render_intent_read_incomplete/);
});
