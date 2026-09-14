import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { AccountPageClient } from "./AccountPageClient";
import DashboardLoading from "../loading";

/**
 * The SimCloud account: profile, password and devices, the active workspace,
 * and pending invitations. Every change here is an explicit action against
 * the account; nothing on this computer moves.
 */
async function AccountContent() {
  await connection();
  await requireAppContext("/dashboard/account");
  return <AccountPageClient />;
}

export default function AccountPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <AccountContent />
    </Suspense>
  );
}
