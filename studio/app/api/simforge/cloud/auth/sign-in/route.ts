import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { signInCloud } from "@/app/lib/cloud/connection";

const Body = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});

/** Email + password sign-in on this computer; answers the fresh connection status. */
export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body, unlocksMaps: true }, (body, signal) => signInCloud(body, signal));
}
