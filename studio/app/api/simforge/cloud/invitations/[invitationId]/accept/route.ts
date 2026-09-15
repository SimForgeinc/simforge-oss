import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { acceptCloudInvitation } from "@/app/lib/cloud/connection";

/** Join the organization; the Cloud answers 403 `email_unverified` until the address is verified. */
export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  const { invitationId } = await context.params;
  return cloudAuthMutation(request, { unlocksMaps: true }, (_body, signal) => acceptCloudInvitation(invitationId, signal));
}
