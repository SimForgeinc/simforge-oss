import { notFound } from "next/navigation";
import { requireAppContext } from "@/app/lib/db/app-context";
import { SimCloudSurface } from "@/app/host";

/**
 * SimCloud: the account, what it unlocks, and the explicit transfers between
 * this computer and a SimCloud organization.
 *
 * The page exists to connect a Studio installation to SimCloud. A hosted
 * installation IS SimCloud, so there is nothing to connect and no transfer to
 * make; the route is not part of that host.
 */
export default async function SimCloudPage() {
  if (SimCloudSurface === null) notFound();
  await requireAppContext("/dashboard/simcloud");
  return <SimCloudSurface />;
}
