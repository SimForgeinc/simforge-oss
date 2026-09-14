import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { acceptCloudInvitationLink } from "@/app/lib/cloud/connection";

/** The pasted invite link or its bare token; the Cloud extracts `token=` itself. */
const Body = z.object({ token: z.string().trim().min(1).max(2048) });

export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body, unlocksMaps: true }, (body, signal) => acceptCloudInvitationLink(body.token, signal));
}
