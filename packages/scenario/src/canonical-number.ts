/**
 * The number grid canonical `.scenario.json` text is written on.
 *
 * A leaf module with no imports, because both ends of the round trip need it:
 * `serialize.ts` quantises onto this grid, and the schema bounds documents by
 * what the grid can express. If this lived with the serializer the schema
 * could not read it without an import cycle.
 */

/** Decimal places kept for every non-integer number. See {@link roundFloat}. */
export const FLOAT_DECIMALS = 6;

/** Above this magnitude `toFixed` starts emitting exponent notation; pass through instead. */
const ROUND_LIMIT = 1e15;

/**
 * Quantise one number for serialization.
 *
 * Rounds to nearest at {@link FLOAT_DECIMALS} decimals. For scene metres that
 * is 1 µm and for radians 1 µrad, and it kills the `0.30000000000000004`
 * noise that makes float diffs unreadable. It is idempotent: rounding an
 * already-rounded value is a no-op, so
 * `serialize(parse(serialize(d))) === serialize(d)`.
 *
 * Rounding to NEAREST means a value can land just outside the range it came
 * from — π is the case that matters, since it rounds up to 3.141593. That is
 * answered where the ranges are declared (see {@link canonicalBound}), not by
 * biasing every number in every document toward zero.
 *
 * @throws If the value is `NaN` or infinite.
 */
export function roundFloat(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`cannot serialize non-finite number: ${value}`);
  }
  if (Number.isInteger(value)) return value === 0 ? 0 : value;
  if (Math.abs(value) >= ROUND_LIMIT) return value;
  const rounded = Number(value.toFixed(FLOAT_DECIMALS));
  return rounded === 0 ? 0 : rounded;
}

/**
 * A schema bound widened to whatever the canonical grid can write.
 *
 * A document that parses must survive its own canonical text. An irrational
 * bound breaks that on its own edge: a yaw of exactly π is a valid mount
 * rotation, `roundFloat` writes it as 3.141593, and a bound of exactly π then
 * refuses the file the serializer just produced. So the bound is the larger of
 * the true limit and the grid point the limit rounds to — 3.141593 rad for a
 * half turn, 3.5e-7 rad of slack, which is four orders of magnitude below any
 * angle anyone authors and does not admit a document anyone would call wrong.
 *
 * Bounds the grid already covers are unchanged: π/2 rounds DOWN, to 1.570796,
 * and widening to that would refuse the exact right angle it is meant to
 * allow. Hence the max, not the rounding.
 *
 * @param limit A positive limit; the range it bounds is `[-limit, +limit]`.
 */
export function canonicalBound(limit: number): number {
  return Math.max(limit, Number(limit.toFixed(FLOAT_DECIMALS)));
}

/** A half turn, as both the schema and the canonical text can express it. */
export const MAX_HALF_TURN_RAD = canonicalBound(Math.PI);

/** A quarter turn, likewise. */
export const MAX_QUARTER_TURN_RAD = canonicalBound(Math.PI / 2);
