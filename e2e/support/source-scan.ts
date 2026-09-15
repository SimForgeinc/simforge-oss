/**
 * A small lexical scanner over TypeScript sources.
 *
 * The suite needs to know which URLs the product *constructs*, not which ones
 * a test happens to visit: a navigation target or an API path that no test
 * exercises is exactly where a dangling route hides. Reading that out of the
 * source is the only way to cover every one of them.
 *
 * Lexical rather than a full parse, deliberately. What is needed is "every
 * string literal whose value looks like a path, and the `method` of the object
 * literal that follows it" — a tokeniser answers that exactly, with no
 * dependency on a TypeScript version and no AST to keep in step with syntax
 * the compiler grows. What it must not do is guess: every helper here either
 * returns a precise answer or reports that it cannot, and the callers treat
 * "cannot" as "do not assert", never as "assume it is fine".
 */

/** A placeholder standing in for a `${…}` interpolation inside a template literal. */
export const INTERPOLATION = "\u0000interpolation";

/** Render a scanned value for a human: placeholders become `${}` again. */
export function readable(value: string): string {
  return value.replaceAll(INTERPOLATION, "${}");
}

/**
 * Blank out comments while preserving every byte offset and line break, so a
 * path mentioned in prose ("…pointed at `/dashboard/scenario/<id>/drive`…")
 * is not mistaken for a live navigation target while reported line numbers
 * still match the file on disk.
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (pair === "//") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (pair === "/*") {
      const close = source.indexOf("*/", index + 2);
      const stop = close === -1 ? source.length : close + 2;
      for (; index < stop; index += 1) out += source[index] === "\n" ? "\n" : " ";
      continue;
    }
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      // Copy the literal verbatim so a `//` or `/*` inside it stays literal.
      out += char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          out += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += source[index];
        if (source[index] === char) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export type ScannedLiteral = {
  /** The literal's value, with each interpolation replaced by {@link INTERPOLATION}. */
  readonly value: string;
  /** Source text of each `${…}`, in order, so a `${base}` can be resolved. */
  readonly expressions: readonly string[];
  /** Offset of the opening quote. */
  readonly start: number;
  /** Offset just past the closing quote. */
  readonly end: number;
};

/** Skip a quoted literal starting at `index`, returning the offset past its close. */
function skipLiteral(source: string, index: number): number {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

/**
 * Every string and template literal in `code`, with interpolations collapsed.
 *
 * Interpolations are consumed with balanced-brace tracking, because a nested
 * quote inside one (`` `/dashboard/scenario${q.size ? "?" + q : ""}` ``) would
 * otherwise truncate the literal and make a perfectly good path look like a
 * broken one.
 */
export function scanLiterals(code: string): ScannedLiteral[] {
  const found: ScannedLiteral[] = [];
  let index = 0;
  while (index < code.length) {
    const quote = code[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    let value = "";
    let closed = false;
    const expressions: string[] = [];
    while (index < code.length) {
      const char = code[index];
      if (char === "\\") {
        value += code[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) {
        closed = true;
        index += 1;
        break;
      }
      if (quote === "`" && char === "$" && code[index + 1] === "{") {
        let depth = 1;
        index += 2;
        const expressionStart = index;
        while (index < code.length && depth > 0) {
          const inner = code[index];
          if (inner === "{") depth += 1;
          else if (inner === "}") depth -= 1;
          else if (inner === '"' || inner === "'" || inner === "`") {
            index = skipLiteral(code, index);
            continue;
          }
          index += 1;
        }
        expressions.push(code.slice(expressionStart, Math.max(expressionStart, index - 1)).trim());
        value += INTERPOLATION;
        continue;
      }
      if (quote !== "`" && char === "\n") break; // an unterminated ordinary literal
      value += char;
      index += 1;
    }
    if (closed) found.push({ value, expressions, start, end: index });
  }
  return found;
}

/** 1-based line of an offset, for `file:line` evidence. */
export function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < code.length; index += 1) {
    if (code[index] === "\n") line += 1;
  }
  return line;
}

/**
 * The HTTP verb a call site uses, read from the inline options object that
 * follows the URL argument, as in `fetch(url, { method: "POST", … })`.
 *
 * Returns `null` — "not statically readable" — for anything it cannot read
 * exactly: a spread, a variable, a conditional, or a `method` living in an
 * argument this does not inspect. Callers must then assert nothing about the
 * verb. That strictness is the point: `hostRequest(path, { dataRoot }, {
 * method: "POST" })` puts the verb in a *third* argument, so assuming "an
 * options object with no method means GET" would have reported the CLI's
 * shutdown call as a GET against a POST-only route — a failure invented by
 * the scan rather than found in the product.
 *
 * Only `fetch` gets the absent-method default, because only `fetch` has a
 * specified one: its second argument is the request init and its default verb
 * is GET.
 */
export function methodAfter(code: string, end: number, callee: string | null): string | null {
  let cursor = end;
  while (cursor < code.length && /\s/.test(code[cursor]!)) cursor += 1;
  if (code[cursor] !== ",") return callee === "fetch" ? "GET" : null;
  cursor += 1;
  while (cursor < code.length && /\s/.test(code[cursor]!)) cursor += 1;
  if (code[cursor] !== "{") return null; // not an inline options object
  const objectStart = cursor;
  let depth = 0;
  let index = cursor;
  for (; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipLiteral(code, index) - 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const body = code.slice(objectStart + 1, index);
  // Only a top-level `method:` in this object describes this request; one
  // nested inside `headers` or a callback belongs to something else.
  let nesting = 0;
  for (let scan = 0; scan < body.length; scan += 1) {
    const char = body[scan];
    if (char === '"' || char === "'" || char === "`") {
      scan = skipLiteral(body, scan) - 1;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") nesting += 1;
    else if (char === "}" || char === "]" || char === ")") nesting -= 1;
    else if (nesting === 0 && body.startsWith("method", scan) && /[^A-Za-z0-9_$]/.test(body[scan - 1] ?? " ")) {
      const rest = body.slice(scan + "method".length);
      const literal = /^\s*:\s*(['"`])([A-Za-z]+)\1/.exec(rest);
      if (literal) return literal[2]!.toUpperCase();
      return null; // a computed method
    }
  }
  if (/\.\.\./.test(body)) return null; // spread options may carry a method
  return callee === "fetch" ? "GET" : null;
}
