import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { revokeCloudSession } from "@/app/lib/cloud/connection";

/** Sign another device of this account out. */
export async function DELETE(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  return cloudAuthMutation(request, {}, async (_body, signal) => {
    await revokeCloudSession(sessionId, signal);
    return { ok: true };
  });
}
