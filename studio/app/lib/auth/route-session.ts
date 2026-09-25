import { connection, NextResponse } from "next/server";
import { LOCAL_SESSION, type AuthenticatedUser } from "@/app/lib/auth/session";

type RouteSessionSuccess = {
  ok: true;
  session: AuthenticatedUser;
  apply<T extends NextResponse>(response: T): T;
};

type RouteSessionFailure = {
  ok: false;
  response: NextResponse;
};

export type RouteSessionResult = RouteSessionSuccess | RouteSessionFailure;

export async function requireRouteSession(_request: Request): Promise<RouteSessionResult> {
  await connection();
  return {
    ok: true,
    session: LOCAL_SESSION,
    apply<T extends NextResponse>(response: T): T {
      return response;
    },
  };
}

/**
 * Writes to the shared map catalog (map metadata, artifacts, candidate
 * locations, the search index). Map assets are global records, so a hosted
 * deployment requires an operator here (the host replaces this module); the
 * local installation has exactly one user, who owns its catalog.
 */
export async function requireMapAssetMutationAccess(request: Request): Promise<RouteSessionResult> {
  return requireRouteSession(request);
}
