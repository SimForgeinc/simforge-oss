import { connection } from "next/server";
import { RunDirectoryViewer } from "../stages/RunDirectoryViewer";

export const instant = false;
export default async function RunViewerPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  await connection();
  const { ref } = await searchParams;
  return <RunDirectoryViewer initialRef={ref} />;
}
