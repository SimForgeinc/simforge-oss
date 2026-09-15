/**
 * Response decoders for the host protocol.
 *
 * Deliberately not zod: this package is consumed by the browser bundle, the
 * CLI and the worker, and the workspace is split between zod 3 (`studio`,
 * `studio-ui`) and zod 4 (`scenario`, `engine`); a shared package pinning
 * either would ship two zods to the browser or block that migration. The
 * decoders below are ~100 lines, cover exactly the DTO vocabulary, and report
 * the failing field by path (`datasets[2].documentCount: expected number, got string`).
 *
 * Policy: every declared field is checked; undeclared fields pass through, so
 * a newer host that adds a field is not refused by an older client (protocol
 * v1 is additive-compatible). Nested domain payloads whose schema is owned
 * elsewhere (`ScenarioTemplateV2`, `RenderSpecV3`, free-form metadata) are
 * typed but not inspected — see `passthrough`.
 */

export class ProtocolDecodeError extends Error {
  constructor(
    /** Dotted/indexed path from the response root, e.g. `documents[0].title`. */
    readonly path: string,
    readonly expected: string,
    readonly received: unknown,
  ) {
    super(`${path}: expected ${expected}, got ${describe(received)}`);
    this.name = "ProtocolDecodeError";
  }
}

export interface Schema<T> {
  parse(value: unknown, path: string): T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  if (typeof value === "object") return "object";
  return `${typeof value} ${String(value)}`;
}

function primitive<T>(type: "string" | "number" | "boolean"): Schema<T> {
  return {
    parse(value, path) {
      if (typeof value !== type || (type === "number" && Number.isNaN(value))) {
        throw new ProtocolDecodeError(path, type, value);
      }
      return value as T;
    },
  };
}

export const string: () => Schema<string> = () => primitive("string");
export const number: () => Schema<number> = () => primitive("number");
export const boolean: () => Schema<boolean> = () => primitive("boolean");

/** Accept anything, including `undefined`. For payloads validated by their own owner. */
export function passthrough<T>(): Schema<T> {
  return { parse: (value) => value as T };
}

export function literal<const T extends string | number | boolean | null>(expected: T): Schema<T> {
  return {
    parse(value, path) {
      if (value !== expected) throw new ProtocolDecodeError(path, JSON.stringify(expected), value);
      return expected;
    },
  };
}

export function oneOf<const T extends readonly (string | number)[]>(values: T): Schema<T[number]> {
  const expected = values.map((v) => JSON.stringify(v)).join(" | ");
  return {
    parse(value, path) {
      if (!(values as readonly unknown[]).includes(value)) throw new ProtocolDecodeError(path, expected, value);
      return value as T[number];
    },
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return { parse: (value, path) => (value === null ? null : inner.parse(value, path)) };
}

/** A key that may be absent. `object` treats `undefined` as "absent" only for optional fields. */
export function optional<T>(inner: Schema<T>): Schema<T | undefined> & { readonly optional: true } {
  return { optional: true, parse: (value, path) => (value === undefined ? undefined : inner.parse(value, path)) };
}

export function array<T>(item: Schema<T>): Schema<T[]> {
  return {
    parse(value, path) {
      if (!Array.isArray(value)) throw new ProtocolDecodeError(path, "array", value);
      return value.map((element, index) => item.parse(element, `${path}[${index}]`));
    },
  };
}

/** A fixed-length tuple, e.g. a `[lon, lat]` pair. */
export function tuple<const S extends readonly Schema<unknown>[]>(
  items: S,
): Schema<{ -readonly [K in keyof S]: Infer<S[K]> }> {
  return {
    parse(value, path) {
      if (!Array.isArray(value) || value.length !== items.length) {
        throw new ProtocolDecodeError(path, `tuple of ${items.length}`, value);
      }
      return items.map((item, index) => item.parse(value[index], `${path}[${index}]`)) as never;
    },
  };
}

export function record<T>(item: Schema<T>): Schema<Record<string, T>> {
  return {
    parse(value, path) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProtocolDecodeError(path, "object", value);
      }
      const out: Record<string, T> = {};
      for (const [key, element] of Object.entries(value)) out[key] = item.parse(element, `${path}.${key}`);
      return out;
    },
  };
}

/**
 * Field-by-field decoder for `T`. The shape must name every key of `T` (the
 * compiler enforces it), so a DTO field cannot be added without deciding how
 * it is validated. Extra keys on the wire are kept.
 */
export type Shape<T> = { readonly [K in keyof T]-?: Schema<T[K]> };

export function object<T extends object>(shape: Shape<T>): Schema<T> {
  const fields = Object.entries(shape) as Array<[string, Schema<unknown> & { optional?: true }]>;
  return {
    parse(value, path) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProtocolDecodeError(path, "object", value);
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = { ...input };
      for (const [key, field] of fields) {
        const fieldPath = path ? `${path}.${key}` : key;
        if (!(key in input) && !field.optional) throw new ProtocolDecodeError(fieldPath, "a value", undefined);
        out[key] = field.parse(input[key], fieldPath);
      }
      return out as T;
    },
  };
}

/**
 * Discriminated union keyed on one literal field. Reports which discriminant
 * value was unrecognised rather than a wall of per-variant failures.
 */
export function discriminated<K extends string, T extends { [P in K]: string }>(
  key: K,
  variants: { [V in T[K]]: Schema<Extract<T, { [P in K]: V }>> },
): Schema<T> {
  const expected = Object.keys(variants).map((v) => JSON.stringify(v)).join(" | ");
  return {
    parse(value, path) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProtocolDecodeError(path, "object", value);
      }
      const tag = (value as Record<string, unknown>)[key];
      const variant = (variants as Record<string, Schema<T> | undefined>)[String(tag)];
      if (typeof tag !== "string" || !variant) throw new ProtocolDecodeError(`${path}.${key}`, expected, tag);
      return variant.parse(value, path);
    },
  };
}

/** First schema that accepts wins; the error reported is the last variant's. */
export function union<const S extends readonly Schema<unknown>[]>(variants: S): Schema<Infer<S[number]>> {
  return {
    parse(value, path) {
      let failure: unknown;
      for (const variant of variants) {
        try {
          return variant.parse(value, path) as Infer<S[number]>;
        } catch (error) {
          failure = error;
        }
      }
      throw failure;
    },
  };
}
