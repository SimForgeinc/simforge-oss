import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { declineCloudInvitation } from "@/app/lib/cloud/connection";

export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  const { invitationId } = await context.params;
  return cloudAuthMutation(request, {}, async (_body, signal) => {
    await declineCloudInvitation(invitationId, signal);
    return { ok: true };
  });
}
