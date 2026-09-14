"use client";

import * as stylex from "@stylexjs/stylex";
import { MonitorCog, Sparkles } from "lucide-react";
import Link from "next/link";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { CloudConnectionCard } from "@/app/components/cloud/CloudConnectionCard";
import { LocalExecutionCard } from "@/app/components/LocalExecutionCard";
import { styles } from "./settings-page.stylex";

export function SettingsPageClient() {
  useSetPageTitle("Settings");
  return (
    <div {...stylex.props(styles.root)}>
      <SkyCloudBackdrop />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.inner)}>
          <LocalExecutionCard />
          <CloudConnectionCard xstyle={styles.cloudCard} />
          <section aria-labelledby="settings-storage-title" {...stylex.props(styles.section)}>
            <p {...stylex.props(styles.eyebrow)}>Storage</p>
            <h2 id="settings-storage-title" {...stylex.props(styles.heading)}>Map cache on this computer</h2>
            <p {...stylex.props(styles.copy)}>
              Downloaded map files live with the rendering profile: pick the folder, move the cache,
              or clear it from Render Settings. Clearing never deletes your projects, jobs or finished renders.
            </p>
            <Button asChild xstyle={styles.action} variant="outline">
              <Link href="/dashboard/render-settings">
                <MonitorCog {...stylex.props(styles.icon)} aria-hidden="true" />
                Rendering profile &amp; map cache
              </Link>
            </Button>
          </section>
          <section aria-labelledby="settings-ai-title" {...stylex.props(styles.section)}>
            <p {...stylex.props(styles.eyebrow)}>Authoring</p>
            <h2 id="settings-ai-title" {...stylex.props(styles.heading)}>AI providers</h2>
            <p {...stylex.props(styles.copy)}>Key for 3D asset generation. Bring your own provider; nothing is set by default.</p>
            <Button asChild xstyle={styles.action} variant="outline">
              <Link href="/dashboard/settings/ai-providers">
                <Sparkles {...stylex.props(styles.icon)} aria-hidden="true" />
                Manage AI providers
              </Link>
            </Button>
          </section>
        </div>
      </div>
    </div>
  );
}
