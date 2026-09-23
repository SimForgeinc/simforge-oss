import * as stylex from "@stylexjs/stylex";
import { styles } from "./layout.stylex";
import { scroll } from "@simforge-oss/studio-ui/stylex/recipes.stylex";
import { Suspense, type ReactNode } from "react";
import { AppTopBar } from "@/app/components/AppTopBar";
import { AppTopBarFrame } from "@/app/components/AppTopBarFrame";
import { TopBarSlotProvider } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { OnboardingGate } from "@/app/components/OnboardingGate";
import { CloudLoadingHost } from "@simforge-oss/studio-ui/components/CloudLoadingHost";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";
import DashboardLoading from "./loading";
import { DashboardWorldBoundary } from "./DashboardWorldBoundary";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <StudioHostBoundary>
      <TopBarSlotProvider>
        <CloudLoadingHost>
          <div {...stylex.props(scroll.clip, styles.divFlex)}>
            {/* AppTopBar reads usePathname(); Suspense lets the static shell
                prerender the frame, which already carries the window drag region. */}
            <Suspense fallback={<AppTopBarFrame />}>
              <AppTopBar />
            </Suspense>
            <main {...stylex.props(scroll.clip, styles.main)}>
              <div {...stylex.props(styles.div)}>
                <Suspense fallback={<DashboardLoading />}>
                  <OnboardingGate>
                    <Suspense fallback={<DashboardLoading />}>
                      <DashboardWorldBoundary>
                        <Suspense fallback={<DashboardLoading />}>{children}</Suspense>
                      </DashboardWorldBoundary>
                    </Suspense>
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
