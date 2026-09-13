"use client";

import Image from "next/image";
import Link from "next/link";
import { Map as MapIcon, MapPin, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import type { ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";
import { maps as styles } from "./asset-surfaces.stylex";

/**
 * Published map versions, for the Maps section of the asset library.
 *
 * The list is the map catalog the scenario editor itself reads, so it is fetched
 * from the same route the editor boots from rather than a second projection that
 * could disagree about which versions are usable. Server order (`label, id`) is
 * preserved: the catalog carries no publication timestamp, and re-sorting here
 * would only invent an order the editor's own picker does not share.
 */
export function MapList({
  reloadToken,
  onUpload,
}: {
  reloadToken: number;
  onUpload: () => void;
}) {
  const [maps, setMaps] = useState<ScenarioMapDescriptorDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    void (async () => {
      try {
        const response = await fetch("/api/simforge/maps", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) {
          throw new Error(`The published map catalog could not be loaded (${response.status}).`);
        }
        const body = (await response.json()) as { maps: ScenarioMapDescriptorDto[] };
        setMaps(body.maps);
      } catch (reason) {
        if (abort.signal.aborted) return;
        setError(
          reason instanceof Error ? reason.message : "The published map catalog could not be loaded.",
        );
      }
    })();
    return () => abort.abort();
  }, [reloadToken]);

  if (error) {
    return <p role="alert" {...stylex.props(styles.error)}>{error}</p>;
  }
  if (maps === null) {
    return <div {...stylex.props(styles.emptyFlush)}><p {...stylex.props(styles.loadingText)}>Loading published maps…</p></div>;
  }
  if (maps.length === 0) {
    return (
      <div {...stylex.props(styles.empty)}>
        <div {...stylex.props(styles.emptyInner)}>
          <MapIcon {...stylex.props(styles.emptyIcon)} />
          <p {...stylex.props(styles.emptyText)}>No maps are published yet.</p>
          <p {...stylex.props(styles.emptyHint)}>
            Upload an OpenDRIVE file and one GLB per layer — a file named <code>road.glb</code> is required — and the server builds the rest.
          </p>
          <Button type="button" onClick={onUpload} xstyle={styles.upload}>Upload a map</Button>
        </div>
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.grid)}>
      {maps.map((map) => (
        <article key={map.mapVersionId} {...stylex.props(styles.card)}>
          <div {...stylex.props(styles.well)}>
            {map.thumbnailUrl ? (
              <Image src={map.thumbnailUrl} alt="" fill sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, (max-width: 1536px) 25vw, 20vw" unoptimized {...stylex.props(styles.thumbnail)} />
            ) : (
              <div {...stylex.props(styles.placeholder)}><MapIcon {...stylex.props(styles.placeholderIcon)} /></div>
            )}
          </div>
          <div {...stylex.props(styles.body)}>
            <h2 {...stylex.props(styles.name)} title={map.label}>{map.label}</h2>
            <div {...stylex.props(styles.locality)}>
              <MapPin {...stylex.props(styles.pin)} aria-hidden="true" />
              <span {...stylex.props(styles.localityText)}>{map.locality ?? "Locality not recorded"}</span>
            </div>
            <p {...stylex.props(styles.id)} title={map.mapVersionId}>{map.mapVersionId}</p>
            <Button asChild size="sm" variant="outline" xstyle={styles.author}>
              <Link href="/dashboard/scenario" aria-label={`Author a scenario on ${map.label}`}>
                <SquarePen aria-hidden="true" /> Author a scenario
              </Link>
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
