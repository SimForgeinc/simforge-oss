import { redirect } from "next/navigation";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";

/** The dashboard root is an entry point: it lands on the app switcher, where choosing an app costs nothing. */
export default async function DashboardPage() {
  await connection();
  await requireAppContext("/dashboard");
  redirect("/dashboard/apps");
}
