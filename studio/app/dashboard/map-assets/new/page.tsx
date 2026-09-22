import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import AddMapPageClient from "./AddMapPageClient";

async function AddMapGate() {
  await connection();
  await requireAppContext("/dashboard/map-assets/new");
  return <AddMapPageClient />;
}

export default function AddMapPage() {
  return <Suspense fallback={null}><AddMapGate /></Suspense>;
}
