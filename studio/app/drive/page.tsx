import { connection } from "next/server";

import { requireAppContext } from "@/app/lib/db/app-context";
import { DriveApp } from "./DriveApp";

// Drive owns a continuously advancing client-side world. Do not prerender a
// second route instance beside the interactive one: there must be one source,
// one control owner, and one truth-to-viewer bridge for the lifetime of a
// session.
export const instant = false;

export default async function DrivePage() {
  await connection();
  await requireAppContext("/drive");
  return <DriveApp />;
}
