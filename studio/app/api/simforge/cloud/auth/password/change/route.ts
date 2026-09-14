import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { changeCloudPassword } from "@/app/lib/cloud/connection";

const Body = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body }, async (body, signal) => {
    await changeCloudPassword(body, signal);
    return { ok: true };
  });
}
