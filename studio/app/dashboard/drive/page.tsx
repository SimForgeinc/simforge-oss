import { Suspense } from "react";
import { connection } from "next/server";

import { listLocalMapCatalog } from "@/app/lib/cloud/maps";
import { requireAppContext } from "@/app/lib/db/app-context";
import { DriveEntry } from "./DriveClient";

export const instant = false;

export default async function DrivePage() {
  await connection();
  await requireAppContext("/dashboard/drive");
  // Same catalog as the Maps app: what this computer holds plus what the
  // current SimCloud authorization allows. Drive never guesses a map; the
  // operator picks one and prepares it here before a world is opened on it.
  const maps = await listLocalMapCatalog();
  return (
    <Suspense fallback={null}>
      <DriveEntry maps={maps} />
    </Suspense>
  );
}
