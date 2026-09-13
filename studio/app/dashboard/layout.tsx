import { Suspense, type ReactNode } from "react";
import { AppTopBar } from "@/app/components/AppTopBar";
import { AppTopBarFrame } from "@/app/components/AppTopBarFrame";
import { TopBarSlotProvider } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { OnboardingGate } from "@/app/components/OnboardingGate";
import { CloudLoadingHost } from "@simforge-oss/studio-ui/components/CloudLoadingHost";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";
import DashboardLoading from "./loading";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <StudioHostBoundary>
      <TopBarSlotProvider>
        <CloudLoadingHost>
          <div className="flex h-svh flex-col overflow-hidden bg-background">
            {/* AppTopBar reads usePathname(); Suspense lets the static shell
                prerender the frame, which already carries the window drag region. */}
            <Suspense fallback={<AppTopBarFrame />}>
              <AppTopBar />
            </Suspense>
            <main className="flex-1 min-h-0 overflow-y-auto">
              <div className="h-full min-h-0">
                <Suspense fallback={<DashboardLoading />}>
                  <OnboardingGate>
                    <Suspense fallback={<DashboardLoading />}>{children}</Suspense>
                  </OnboardingGate>
                </Suspense>
              </div>
            </main>
          </div>
        </CloudLoadingHost>
      </TopBarSlotProvider>
    </StudioHostBoundary>
  );
}
