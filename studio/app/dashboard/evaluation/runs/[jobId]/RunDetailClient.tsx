"use client";

/**
 * One cloud run's result on the desktop — the same component the web portal
 * renders, so a run submitted in the browser and opened here shows identical
 * metrics, provenance and refusals.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { JobDetail } from "@simforge-oss/studio-ui/evaluation";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { useEvaluationGateway } from "@/app/lib/host/evaluation";

export function RunDetailClient({ jobId }: { jobId: string }) {
  useSetPageTitle("Run");
  // Reads are workspace-resolved from the connected session; only writes need
  // an explicit workspace, and this screen performs none.
  const gateway = useEvaluationGateway(null);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title="Run"
        description="A cloud evaluation run in this workspace."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/evaluation">
              <ArrowLeft aria-hidden="true" />
              All runs
            </Link>
          </Button>
        }
      />
      <div className="px-5 py-5 sm:px-6">
        <JobDetail gateway={gateway} jobId={jobId} />
      </div>
    </div>
  );
}
