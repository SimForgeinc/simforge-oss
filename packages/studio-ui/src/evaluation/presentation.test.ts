import { expect, it } from "vitest";
import { submissionIdempotencyKey } from "./presentation";

it("keeps seven-camera retries within the API limit without merging distinct intents", async () => {
  const parts = {
    kind: "alpamayo.openloop",
    family: "alpamayo-1.5",
    quant: "bf16",
    revision: "7aba8293c09993f2e125c6819df05d7fa3e873ea",
    artifactIds: Array.from({ length: 7 }, (_, index) => `cart_${String(index).padStart(24, "0")}`),
    attempt: "prepared-intent",
  };
  const key = await submissionIdempotencyKey(parts);
  expect(key.length).toBeLessThanOrEqual(200);
  expect(await submissionIdempotencyKey({ ...parts, artifactIds: [...parts.artifactIds] })).toBe(key);
  expect(await submissionIdempotencyKey({ ...parts, artifactIds: [...parts.artifactIds].reverse() })).not.toBe(key);
  expect(await submissionIdempotencyKey({ ...parts, attempt: "new-intent" })).not.toBe(key);
});
