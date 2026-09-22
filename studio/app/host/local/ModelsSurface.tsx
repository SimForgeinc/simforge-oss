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
import { AppStage } from "@/app/components/AppStage";

export function ModelsSurface() {
  return (
    <AppStage
      fill
      title="Models"
      eyebrow="Local model store"
      testId="models-stage"
    >
      <ModelStorePanel />
    </AppStage>
  );
}
