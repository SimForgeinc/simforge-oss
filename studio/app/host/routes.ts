import { HOST_KIND } from "@/app/lib/host/kind";

/**
 * Routes this host does not serve.
 *
 * The surfaces in `./local` and `./cloud` decide what a page renders; this
 * decides whether the page is routed at all. Both are needed, and they are not
 * the same check: a page that calls `notFound()` under the dashboard layout
 * renders the not-found screen, but the layout's shell has already streamed,
 * so the response carries 200. A path the product does not have must answer
 * like a path that was never written — status included — which only something
 * above the render can do, and the proxy is that thing.
 *
 * Component-free on purpose: the proxy runs before React and must not pull a
 * surface module into the middleware bundle. It keys off `lib/host/kind`, the
 * module a hosted deployment already replaces, so there is one declaration of
 * which host this is and no second list to keep in step.
 */
export const LOCAL_ONLY_ROUTE_PREFIXES = [
  /** Everything about the machine this installation runs on. */
  "/dashboard/settings",
  /** Downloads model weights to it and prepares their runtime. */
  "/dashboard/models",
  /** Connects this installation to SimCloud; a cloud host IS SimCloud. */
  "/dashboard/simcloud",
  /** Deep link into a run executed by that machine's own model-run queue. */
  "/dashboard/evaluation/local",
  /** First run: which mode, which maps, which runtime — all local questions. */
  "/onboarding",
] as const;

/** The prefixes THIS host refuses to route, in the order they are tested. */
export const UNSERVED_ROUTE_PREFIXES: readonly string[] =
  HOST_KIND === "cloud" ? LOCAL_ONLY_ROUTE_PREFIXES : [];

export function isUnservedRoute(pathname: string): boolean {
  return UNSERVED_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
