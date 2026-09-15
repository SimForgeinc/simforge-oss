import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import { EvaluationPageClient } from "./EvaluationPageClient";

export default async function EvaluationPage() {
  await connection();
  await requireAppContext("/dashboard/evaluation");
  return <EvaluationPageClient />;
}
