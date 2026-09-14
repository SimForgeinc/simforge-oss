import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { setCloudActiveWorkspace } from "@/app/lib/cloud/connection";

const Body = z.object({ organizationId: z.string().trim().min(1).max(200) });

/** Choose the workspace this sign-in acts in; answers the fresh connection status. */
export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body, unlocksMaps: true }, (body, signal) => setCloudActiveWorkspace(body.organizationId, signal));
}
