// The gate itself is a host slot: see app/host/proxy.ts and host-slots.json.
export { proxy } from "@/app/host/proxy";

export const config = {
  // `/api/local-objects/**` is excluded from the matcher, not waved through
  // inside the handler. A matched request has its body buffered by the
  // framework before this function runs, capped at 10 MiB and TRUNCATED past
  // it, which silently cut render uploads short and surfaced as a checksum
  // mismatch. The route verifies its own expiring method/path/query signature
  // on every verb and streams the body itself, so excluding it removes a
  // buffer rather than a check.
  matcher: ["/((?!_next/static/|favicon.ico$|icon.svg$|api/local-objects/).*)"],
};
