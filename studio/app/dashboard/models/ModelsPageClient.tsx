"use client";

/**
 * The model catalogue on this machine.
 *
 * Download and execution are presented as the separate questions they are: a
 * machine with disk but a small GPU can hold Alpamayo 2 Super and still run it
 * in the cloud, and this screen says so per model and per precision rather
 * than hiding what the hardware cannot do.
 */

import { ModelStorePanel } from "@simforge-oss/studio-ui/evaluation/model-store";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";

export function ModelsPageClient() {
  useSetPageTitle("Models");

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title="Models"
        description="Download, verify and remove Alpamayo weights. Downloading a model is separate from being able to execute it — cloud runs need no local download at all."
      />
      <div className="px-5 py-5 sm:px-6">
        <ModelStorePanel />
      </div>
    </div>
  );
}
