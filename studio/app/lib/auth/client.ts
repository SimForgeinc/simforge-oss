import { LOCAL_SESSION } from "@/app/lib/auth/session";

export const authClient = {
  async getSession() {
    return { data: { user: LOCAL_SESSION } };
  },
};
