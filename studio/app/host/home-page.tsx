import type { Metadata } from "next";
import { redirect } from "next/navigation";

/**
 * `/` for this host (a slot: see host-slots.json). The local host has no
 * landing page; it opens the dashboard.
 */
export const metadata: Metadata = {};

export default function HomePage(_props: { searchParams: Promise<Record<string, string | string[] | undefined>> }): never {
  redirect("/dashboard");
}
