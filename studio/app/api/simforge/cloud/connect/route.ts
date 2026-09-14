import { z } from "zod";
import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { beginCloudConnect } from "@/app/lib/cloud/connection";

const Body = z.object({
  provider: z.enum(["google", "github"]),
  origin: z.string().optional(),
});

/** Start the Google/GitHub sign-in; the renderer opens `authorizationUrl` in the system browser. */
export function POST(request: Request) {
  return cloudAuthMutation(request, { body: Body }, (body) => beginCloudConnect(body));
}
