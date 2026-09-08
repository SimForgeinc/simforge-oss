"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { MapAssetCacheStorage } from "@simforge-oss/studio-ui/components/MapAssetCacheStorage";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { CloudConnectionCard } from "@/app/components/cloud/CloudConnectionCard";
import { LocalExecutionCard } from "@/app/components/LocalExecutionCard";

/**
 * One settings surface for the installed app: who owns the data and what runs
 * here, the optional SimCloud account, and where map bytes live on disk.
 */
export function SettingsPageClient() {
  useSetPageTitle("Settings");

  return (
    <div className="relative h-full min-h-0 overflow-hidden text-white">
      <SkyCloudBackdrop className="absolute" />
      <div className="relative z-10 h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-5 py-10 sm:px-8 sm:py-14">
          <LocalExecutionCard />
          <CloudConnectionCard className="border-t border-white/10 pt-8" />
          <section aria-labelledby="settings-storage-title" className="border-t border-white/10 pt-8">
            <p className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">Storage</p>
            <h2 id="settings-storage-title" className="mt-1 text-lg font-semibold">
              Map cache on this computer
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/55">
              Downloaded map files are kept here so maps open instantly and renders never re-download. Clearing the
              cache never deletes your projects, jobs or finished renders.
            </p>
            <MapAssetCacheStorage className="mt-4 border-t-0" />
          </section>
          <section aria-labelledby="settings-ai-title" className="border-t border-white/10 pt-8">
            <p className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">Authoring</p>
            <h2 id="settings-ai-title" className="mt-1 text-lg font-semibold">
              AI providers
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/55">
              Key for 3D asset generation. Bring your own provider; nothing is set by default.
            </p>
            <Button asChild className="mt-4 h-10 gap-2 rounded-full border-white/15 bg-transparent text-white hover:bg-white/5" variant="outline">
              <Link href="/dashboard/settings/ai-providers">
                <Sparkles className="size-4" aria-hidden="true" />
                Manage AI providers
              </Link>
            </Button>
          </section>
        </div>
      </div>
    </div>
  );
}
