import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { signUpCloud } from "@/app/lib/cloud/connection";

const Body = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(256),
  name: z.string().trim().min(1).max(120),
});

/** Create the account and sign this computer in; the verification code is emailed. */
export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body, unlocksMaps: true }, (body, signal) => signUpCloud(body, signal));
}
