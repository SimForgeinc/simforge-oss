import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { forgotCloudPassword } from "@/app/lib/cloud/connection";

const Body = z.object({ email: z.string().trim().email().max(254) });

/** Always `{ok:true}`: the Cloud does not reveal whether the address has an account. */
export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body }, async (body, signal) => {
    await forgotCloudPassword(body.email, signal);
    return { ok: true };
  });
}
