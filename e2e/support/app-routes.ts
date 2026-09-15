/**
 * The App Router's own route table, read off the filesystem, plus every URL
 * the product's source constructs against it.
 *
 * This exists because of a defect class that the unit suite is structurally
 * blind to. A component that builds `/dashboard/scenario/<id>/drive` and a
 * page that lives at `app/dashboard/drive/[documentId]/page.tsx` are each
 * individually correct and each individually unit-tested; the bug is only in
 * the *relationship* between them, and nothing that tests one file at a time
 * can see it. The same shape recurs for API routes: a caller that POSTs and a
 * route module that only exports `GET` are both fine on their own, which is
 * how commit `e3bf1229` deleted two POST handlers without turning anything
 * red.
 *
 * So: enumerate both sides from disk, and assert them against each other.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { INTERPOLATION, lineOf, methodAfter, scanLiterals, stripComments } from "./source-scan";
import { REPO_ROOT, STUDIO_ROOT } from "./paths";

const APP_ROOT = join(STUDIO_ROOT, "app");
const API_ROOT = join(APP_ROOT, "api");

/** The verbs Next.js will route to a `route.ts` export. */
export const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpVerb = (typeof HTTP_VERBS)[number];

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export type RouteEntry = {
  /** Repository-relative path of the `page.tsx` or `route.ts` that serves it. */
  readonly file: string;
  /** Path segments, route groups removed; dynamic ones keep their brackets. */
  readonly segments: readonly string[];
  /** Exported HTTP verbs; empty for pages. */
  readonly verbs: readonly HttpVerb[];
};

/** Path segments a file serves; route groups (`app/(marketing)/about`) are transparent. */
function segmentsFor(root: string, file: string, prefix: readonly string[]): string[] {
  const parts = relative(root, file).split(sep).slice(0, -1);
  return [...prefix, ...parts.filter((part) => !(part.startsWith("(") && part.endsWith(")")))];
}

/** Every navigable App Router page. */
export async function pageRoutes(): Promise<RouteEntry[]> {
  const routes: RouteEntry[] = [];
  for await (const file of walk(APP_ROOT)) {
    if (!/[\\/]page\.tsx?$/.test(file)) continue;
    routes.push({ file: relative(REPO_ROOT, file), segments: segmentsFor(APP_ROOT, file, []), verbs: [] });
  }
  return routes.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * Every API route module and the verbs it exports.
 *
 * Read from the source text rather than by importing the module: a route
 * module pulls in the database, the cloud client and the access gate, and the
 * question here is only which handlers Next.js would mount.
 */
export async function apiRoutes(): Promise<RouteEntry[]> {
  const routes: RouteEntry[] = [];
  for await (const file of walk(API_ROOT)) {
    if (!/[\\/]route\.tsx?$/.test(file)) continue;
    const source = await readFile(file, "utf8");
    const verbs = HTTP_VERBS.filter((verb) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`).test(source)
      || new RegExp(`export\\s+(?:const|let|var)\\s+${verb}\\b`).test(source)
      || new RegExp(`export\\s*\\{[^}]*\\b${verb}\\b[^}]*\\}`).test(source));
    routes.push({ file: relative(REPO_ROOT, file), segments: segmentsFor(API_ROOT, file, ["api"]), verbs });
  }
  return routes.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * Does `path` match a route's segment pattern?
 *
 * The one rule that makes this able to catch the `driveHref` bug: a *literal*
 * segment in the pattern is never satisfied by an interpolation in the path.
 * `/dashboard/scenario/${id}/drive` therefore cannot match
 * `dashboard/scenario/[datasetId]` — the trailing literal `drive` has nothing
 * to sit on — and the target is reported as unresolved instead of being
 * waved through by a permissive dynamic match.
 */
function matches(pattern: readonly string[], path: readonly string[]): boolean {
  let index = 0;
  for (; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    if (expected.startsWith("[[...")) return true; // optional catch-all also matches zero
    if (expected.startsWith("[...")) return path.length > index;
    if (index >= path.length) return false;
    if (expected.startsWith("[") && expected.endsWith("]")) continue;
    if (path[index] === INTERPOLATION) return false;
    if (expected !== path[index]) return false;
  }
  return path.length === index;
}

/**
 * The route that would serve `path`, or `null`.
 *
 * Static segments beat dynamic ones in Next.js, so `/api/map-assets/upload-url`
 * is served by `map-assets/upload-url/route.ts` even though
 * `map-assets/[mapAssetId]/route.ts` also matches. Ranking by specificity
 * reproduces that; ignoring it would compare a caller against the wrong
 * module's verb list and invent failures.
 */
export function resolveRoute(routes: readonly RouteEntry[], path: readonly string[]): RouteEntry | null {
  let best: RouteEntry | null = null;
  let bestLiterals = -1;
  for (const route of routes) {
    if (!matches(route.segments, path)) continue;
    const literals = route.segments.filter((segment) => !segment.startsWith("[")).length;
    if (literals > bestLiterals) {
      best = route;
      bestLiterals = literals;
    }
  }
  return best;
}

export type UrlUsage = {
  /** The literal as written, interpolations collapsed to {@link INTERPOLATION}. */
  readonly value: string;
  /** Path segments of {@link UrlUsage.value}, query and fragment removed. */
  readonly segments: readonly string[];
  /** The verb read from an adjacent inline options object, or `null` when unreadable. */
  readonly method: string | null;
  /**
   * The URL is a *base* the code appends an unknown suffix to, so only the
   * namespace can be asserted, not one route. True when the last path segment
   * was a literal with an interpolation glued onto its end
   * (`` `${CLOUD_ROOT}${path}` ``) or the path ended in a slash.
   */
  readonly prefixOnly: boolean;
  /** The function this literal is the first argument of, or `null` when it is not a call. */
  readonly callee: string | null;
  /** `path/to/file.ts:line`, repository-relative. */
  readonly site: string;
};

/**
 * The name of the function whose first argument starts at `start`.
 *
 * Needed to tell a request from a label. Several modules use in-app paths as
 * synthetic Cache Storage keys — `artifact-cache.ts` says so in as many words:
 * "Synthetic origin path; never fetched, it only names the entry by digest" —
 * and asserting that those resolve to a route module would demand routes that
 * are not supposed to exist. Keying on the callee restricts the assertions to
 * literals the product really sends somewhere.
 */
function calleeBefore(code: string, start: number): string | null {
  let cursor = start - 1;
  while (cursor >= 0 && /\s/.test(code[cursor]!)) cursor -= 1;
  if (code[cursor] !== "(") return null;
  cursor -= 1;
  while (cursor >= 0 && /\s/.test(code[cursor]!)) cursor -= 1;
  // `request<UploadReservation>(…)` — step back over the type arguments, or
  // every generic call in the typed host client reads as "not a call".
  if (code[cursor] === ">") {
    let depth = 0;
    for (; cursor >= 0; cursor -= 1) {
      if (code[cursor] === ">") depth += 1;
      else if (code[cursor] === "<") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    cursor -= 1;
    while (cursor >= 0 && /\s/.test(code[cursor]!)) cursor -= 1;
  }
  const end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(code[cursor]!)) cursor -= 1;
  const name = code.slice(cursor + 1, end);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : null;
}

/**
 * Is this value a base rather than a whole URL? A trailing slash, or a final
 * segment whose literal text has an interpolation glued to its end, both mean
 * the code appends more path before sending it.
 */
function isPrefixOnly(value: string): boolean {
  const path = value.split(/[?#]/)[0]!;
  if (path.endsWith("/")) return true;
  const last = path.split("/").at(-1) ?? "";
  return last.endsWith(INTERPOLATION) && last !== INTERPOLATION;
}

/** Sources that construct URLs the product then navigates or fetches. */
const SOURCE_ROOTS = [
  join(STUDIO_ROOT, "app"),
  join(REPO_ROOT, "packages", "studio-ui", "src"),
  join(REPO_ROOT, "packages", "studio-host", "src"),
  join(REPO_ROOT, "packages", "cli", "src"),
] as const;

/**
 * Split a URL literal into path segments.
 *
 * A trailing interpolation often carries the query string
 * (`` `/dashboard/scenario${params.size ? `?${params}` : ""}` ``), so a
 * segment that is a literal with a placeholder glued to its end is reduced to
 * the literal: the path is `/dashboard/scenario`, and treating the
 * interpolation as part of the segment name would make it unresolvable.
 */
export function urlSegments(value: string): string[] {
  const path = value.split(/[?#]/)[0]!;
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment !== INTERPOLATION && segment.endsWith(INTERPOLATION)
        ? segment.slice(0, -INTERPOLATION.length)
        : segment);
}

/**
 * Every URL literal in the product's sources whose value starts with one of
 * `prefixes`, with the verb of an adjacent inline options object.
 */
export async function collectUrlUsage(prefixes: readonly string[]): Promise<UrlUsage[]> {
  const usage: UrlUsage[] = [];
  for (const root of SOURCE_ROOTS) {
    for await (const file of walk(root)) {
      if (!/\.tsx?$/.test(file) || /__tests__|[.](test|spec)[.]tsx?$/.test(file)) continue;
      const code = stripComments(await readFile(file, "utf8"));
      const relativeFile = relative(REPO_ROOT, file);
      const literals = scanLiterals(code);

      /*
       * Path bases bound to a local constant. The host client writes
       *
       *   const base = `/api/simforge/documents/${id}/simulation-preview`;
       *   await request(`${base}/reserve`, { method: "POST" });
       *
       * so the path literal is nobody's first argument and the request
       * literal begins with an interpolation. Without resolving `base`, the
       * whole of `http-client.ts` — which is how the CLI and the worker reach
       * the API — is invisible to this scan, and deleting a POST handler that
       * only it calls stays green. Single assignment only: a rebound name is
       * ambiguous and is left unresolved rather than guessed at.
       */
      const declarations: { name: string; value: string; offset: number }[] = [];
      for (const literal of literals) {
        const declaration = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?=\s*$/
          .exec(code.slice(Math.max(0, literal.start - 200), literal.start));
        if (declaration === null) continue;
        declarations.push({ name: declaration[1]!, value: literal.value, offset: literal.start });
      }
      /*
       * The nearest *preceding* declaration of a name, which is what the code
       * at that point is actually referring to. `http-client.ts` declares a
       * local `const base` in three different methods — simulation preview,
       * materialized traffic, and one more — so treating a repeated name as
       * ambiguous skipped every one of them, and a scan that skips the host
       * client is blind to how the CLI and worker reach the API. Textual
       * proximity within one file is as far as this goes: no cross-file
       * inference, and an unresolvable name is skipped rather than guessed.
       */
      const nearestBase = (name: string, before: number): string | null => {
        let best: string | null = null;
        let bestOffset = -1;
        for (const declaration of declarations) {
          if (declaration.name !== name || declaration.offset >= before || declaration.offset <= bestOffset) continue;
          best = declaration.value;
          bestOffset = declaration.offset;
        }
        return best;
      };

      for (const literal of literals) {
        let value = literal.value;
        if (value.startsWith(INTERPOLATION)) {
          const head = literal.expressions[0] ?? "";
          const rest = value.slice(INTERPOLATION.length);
          const bound = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(head) ? nearestBase(head, literal.start) : null;
          if (bound !== null) value = bound + rest;
          // `${baseUrl}/api/…` — an absolute URL against the host's own
          // origin. The origin is irrelevant to which route module serves it,
          // so the path is what matters.
          else if (prefixes.some((prefix) => rest.startsWith(prefix))) value = rest;
        }
        if (!prefixes.some((prefix) => value.startsWith(prefix))) continue;
        const callee = calleeBefore(code, literal.start);
        usage.push({
          value,
          segments: urlSegments(value),
          method: methodAfter(code, literal.end, callee),
          callee,
          prefixOnly: isPrefixOnly(value),
          site: `${relativeFile}:${lineOf(code, literal.start)}`,
        });
      }

      /*
       * Calls that pass a bound path as the whole URL, not interpolated into
       * one: `request<UploadReservation>(base, { method: "POST" })`. This is
       * the call that reserves a simulation preview, and it is the reason
       * deleting that route's POST handler stayed green until this scan grew
       * the case — the URL never appears as a literal at the call site at all.
       */
      const callWithBoundUrl = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,)])/g;
      for (let call = callWithBoundUrl.exec(code); call !== null; call = callWithBoundUrl.exec(code)) {
        const value = nearestBase(call[2]!, call.index);
        if (value === null || !prefixes.some((prefix) => value.startsWith(prefix))) continue;
        usage.push({
          value,
          segments: urlSegments(value),
          method: methodAfter(code, call.index + call[0].length, call[1]!),
          callee: call[1]!,
          prefixOnly: isPrefixOnly(value),
          site: `${relativeFile}:${lineOf(code, call.index)}`,
        });
      }
    }
  }
  return usage;
}

/** The route modules that live under a path prefix, used to validate base URLs. */
export function routesBeneath(routes: readonly RouteEntry[], prefix: readonly string[]): RouteEntry[] {
  return routes.filter((route) =>
    route.segments.length > prefix.length
    && prefix.every((segment, index) => {
      const actual = route.segments[index]!;
      return actual === segment || (actual.startsWith("[") && segment !== INTERPOLATION);
    }));
}
