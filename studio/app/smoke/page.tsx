import * as stylex from "@stylexjs/stylex";
import { styles } from "./page.stylex";
import { AppTopBar } from "@/app/components/AppTopBar";
import { TopBarSlotProvider } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { StudioHostBoundary } from "@/app/lib/host/StudioHostBoundary";
import { typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

export default function SmokePage() {
  return (
    <StudioHostBoundary>
      <TopBarSlotProvider>
        <div {...stylex.props(styles.div)}>
          <AppTopBar />
          <main {...stylex.props(styles.main)}>
            <p {...stylex.props([typography.caps, styles.localPlatform])}>Local platform</p>
            <h1 {...stylex.props(styles.simforgeChromeSmokeSurface)}>SimForge chrome smoke surface</h1>
          </main>
        </div>
      </TopBarSlotProvider>
    </StudioHostBoundary>
  );
}
