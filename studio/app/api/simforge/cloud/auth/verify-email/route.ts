import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { verifyCloudEmail } from "@/app/lib/cloud/connection";

const Body = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body, unlocksMaps: true }, (body, signal) => verifyCloudEmail(body.code, signal));
}
