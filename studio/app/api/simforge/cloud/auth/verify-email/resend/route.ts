import { cloudAuthMutation } from "@/app/lib/cloud/auth-routes";
import { resendCloudVerification } from "@/app/lib/cloud/connection";

export function POST(request: Request) {
  return cloudAuthMutation(request, {}, (_body, signal) => resendCloudVerification(signal));
}
