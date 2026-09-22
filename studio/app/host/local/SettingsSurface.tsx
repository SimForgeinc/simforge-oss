"use client";

import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Cloud, MonitorCog } from "lucide-react";
import Link from "next/link";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { AppStage } from "@/app/components/AppStage";
import { plate } from "@/app/components/AppStage.stylex";
import { AiProviderSettings } from "./AiProviderSettings";
import { LocalExecutionCard } from "./LocalExecutionCard";

/**
 * Settings, in the app switcher's chrome: the same backdrop and hairline
 * plates as a switcher tab, a stage that does not scroll the page, and one
 * bounded settings section inside it. Everything about this computer is here; the
 * SimCloud account has its own surface and is linked, not duplicated.
 */
export function SettingsSurface() {
  const [section, setSection] = useState("computer");
  return (
    <AppStage
      fill
      eyebrow="Utility"
      title="Settings"
      testId="settings-panel"
    >
      <div {...stylex.props(plate.scroller)}>
        <nav {...stylex.props(plate.tabs)} aria-label="Settings sections">
          {[["computer", "This computer"], ["ai", "AI providers"], ["storage", "Storage"], ["account", "Account"]].map(([id, label]) => <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id!)} {...stylex.props(plate.tab, section === id ? plate.tabActive : plate.tabIdle)}>{label}</button>)}
        </nav>
        <div>
      {section === "computer" ? <LocalExecutionCard /> : null}
      {section === "ai" ? <AiProviderSettings /> : null}
      {section === "storage" ? <section {...stylex.props(plate.root)}>
        <p {...stylex.props(plate.eyebrow)}>Storage</p>
        <h2 {...stylex.props(plate.title)}>Map cache on this computer</h2>
        <p {...stylex.props(plate.copy)}>
          Downloaded map files live with the rendering profile: pick the folder, move the cache, or clear it
          from Render Settings. Clearing never deletes your projects, jobs or finished renders.
        </p>
        <div {...stylex.props(plate.row)}>
          <Button asChild xstyle={plate.button} variant="outline">
            <Link href="/dashboard/apps?view=render-settings">
              <MonitorCog {...stylex.props(plate.icon)} aria-hidden="true" />
              Rendering profile &amp; map cache
            </Link>
          </Button>
        </div>
      </section> : null}
      {section === "account" ? <section {...stylex.props(plate.root)}>
        <p {...stylex.props(plate.eyebrow)}>Account</p>
        <h2 {...stylex.props(plate.title)}>SimCloud</h2>
        <p {...stylex.props(plate.copy)}>
          Signing in adds your account&apos;s maps, cloud models and cloud storage. Everything on this computer
          works without an account.
        </p>
        <div {...stylex.props(plate.row)}>
          <Button asChild xstyle={[plate.button, plate.buttonAccent]}>
            <Link href="/dashboard/simcloud">
              <Cloud {...stylex.props(plate.icon)} aria-hidden="true" />
              Open SimCloud
            </Link>
          </Button>
        </div>
      </section> : null}
        </div>
      </div>
    </AppStage>
  );
}
