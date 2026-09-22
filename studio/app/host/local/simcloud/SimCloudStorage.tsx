"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { styles } from "./SimCloudStorage.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  CloudDownload,
  CloudUpload,
  Database,
  FileBox,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type {
  IndexedArtifact,
  ScenarioDatasetDto,
  StudioCloudOrganization,
} from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { plate } from "@/app/components/AppStage.stylex";
import { studioHost } from "@/app/lib/host";
import { studioCloud, cloudErrorMessage, useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * Datasets and artifacts in a SimCloud organization next to the ones on this
 * computer, with explicit import, publish and upload between them — the
 * capability the separate "Cloud Storage" tab used to hold, now a pane of the
 * one SimCloud surface.
 *
 * Every transfer is an intentional click. Link records (read from the local
 * service, no connection needed) show which local datasets and artifacts are
 * working copies of cloud content and whether local edits are still
 * unpublished. Conflicts come back as messages naming the scenarios; nothing
 * here resolves them on its own.
 */

type CloudDatasetLink = {
  localDatasetId: string;
  origin: string;
  remoteOrganizationId: string;
  remoteDatasetId: string;
  remoteDatasetName: string;
  lastImportedAt: string | null;
  lastPublishedAt: string | null;
  unpublishedDocumentCount: number;
};

type CloudArtifactLink = {
  localArtifactId: string;
  origin: string;
  remoteOrganizationId: string;
  remoteArtifactId: string;
  direction: "import" | "upload";
  sha256: string;
  syncedAt: string;
};

type Notice = { tone: "error" | "success"; text: string };

async function readLinks<T>(path: string): Promise<T[]> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Local link read failed (${response.status}).`);
  const body = (await response.json()) as { links: T[] };
  return body.links;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWhen(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export function SimCloudStorage({
  organizations,
  organizationId,
  onOrganizationChange,
}: {
  organizations: StudioCloudOrganization[];
  organizationId: string | null;
  onOrganizationChange: (organizationId: string | null) => void;
}) {
  const cloud = useStudioCloudStatus();
  const origin = cloud.status?.origin ?? null;

  const [cloudDatasets, setCloudDatasets] = useState<ScenarioDatasetDto[]>([]);
  const [cloudArtifacts, setCloudArtifacts] = useState<IndexedArtifact[]>([]);
  const [localDatasets, setLocalDatasets] = useState<ScenarioDatasetDto[]>([]);
  const [localArtifacts, setLocalArtifacts] = useState<IndexedArtifact[]>([]);
  const [datasetLinks, setDatasetLinks] = useState<CloudDatasetLink[]>([]);
  const [artifactLinks, setArtifactLinks] = useState<CloudArtifactLink[]>([]);
  const [publishTargets, setPublishTargets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const organization = useMemo(
    () => organizations.find((candidate) => candidate.id === organizationId) ?? null,
    [organizations, organizationId],
  );

  const loadLocal = useCallback(async () => {
    const [datasets, artifacts, datasetLinkRows, artifactLinkRows] = await Promise.all([
      studioHost.projects.listDatasets(),
      studioHost.artifacts.listArtifactIndex({ limit: 200 }),
      readLinks<CloudDatasetLink>("/api/simforge/cloud/datasets/links"),
      readLinks<CloudArtifactLink>("/api/simforge/cloud/artifacts/links"),
    ]);
    setLocalDatasets(datasets);
    setLocalArtifacts(artifacts);
    setDatasetLinks(datasetLinkRows);
    setArtifactLinks(artifactLinkRows);
  }, []);

  const loadOrganizationContent = useCallback(async (id: string) => {
    const [datasets, artifacts] = await Promise.all([
      studioCloud.listDatasets(id),
      studioCloud.listArtifacts(id),
    ]);
    setCloudDatasets(datasets);
    setCloudArtifacts(artifacts);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await loadLocal();
      if (organizationId) await loadOrganizationContent(organizationId);
    } catch (reason) {
      setNotice({ tone: "error", text: cloudErrorMessage(reason, "Cloud storage could not be loaded.") });
    } finally {
      setLoading(false);
    }
  }, [loadLocal, loadOrganizationContent, organizationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const linkForRemoteDataset = useCallback(
    (remoteDatasetId: string) =>
      datasetLinks.find(
        (link) => link.origin === origin && link.remoteOrganizationId === organizationId && link.remoteDatasetId === remoteDatasetId,
      ) ?? null,
    [datasetLinks, origin, organizationId],
  );
  const linkForLocalDataset = useCallback(
    (localDatasetId: string) => datasetLinks.find((link) => link.localDatasetId === localDatasetId) ?? null,
    [datasetLinks],
  );
  const linkForRemoteArtifact = useCallback(
    (remoteArtifactId: string) =>
      artifactLinks.find(
        (link) => link.origin === origin && link.remoteOrganizationId === organizationId && link.remoteArtifactId === remoteArtifactId,
      ) ?? null,
    [artifactLinks, origin, organizationId],
  );
  const linkForLocalArtifact = useCallback(
    (localArtifactId: string) =>
      artifactLinks.find(
        (link) => link.origin === origin && link.remoteOrganizationId === organizationId && link.localArtifactId === localArtifactId,
      ) ?? null,
    [artifactLinks, origin, organizationId],
  );

  async function run(key: string, act: () => Promise<string>) {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    try {
      const text = await act();
      setNotice({ tone: "success", text });
      await loadLocal();
      if (organizationId) await loadOrganizationContent(organizationId);
    } catch (reason) {
      setNotice({ tone: "error", text: cloudErrorMessage(reason, "The transfer failed.") });
    } finally {
      setBusy(null);
    }
  }

  const importDataset = (dataset: ScenarioDatasetDto) =>
    run(`import-dataset:${dataset.id}`, async () => {
      if (!organizationId) throw new Error("Choose an organization first.");
      const local = await studioCloud.importDataset({ organizationId, datasetId: dataset.id });
      return `"${dataset.name}" is now a local working copy (${local.documentCount} scenario${local.documentCount === 1 ? "" : "s"}, dataset "${local.name}").`;
    });

  const publishDataset = (dataset: ScenarioDatasetDto) =>
    run(`publish-dataset:${dataset.id}`, async () => {
      if (!organizationId) throw new Error("Choose an organization first.");
      const link = linkForLocalDataset(dataset.id);
      const chosen = publishTargets[dataset.id];
      const remoteDatasetId =
        chosen === "new" ? undefined : chosen ?? (link && link.remoteOrganizationId === organizationId && link.origin === origin ? link.remoteDatasetId : undefined);
      const result = await studioCloud.publishDataset({ datasetId: dataset.id, organizationId, remoteDatasetId });
      return result.documents === 0
        ? `"${dataset.name}" is already up to date in SimCloud.`
        : `Published ${result.documents} scenario${result.documents === 1 ? "" : "s"} from "${dataset.name}" to SimCloud.`;
    });

  const importArtifact = (artifact: IndexedArtifact) =>
    run(`import-artifact:${artifact.id}`, async () => {
      if (!organizationId) throw new Error("Choose an organization first.");
      const local = await studioCloud.importArtifact({ organizationId, artifactId: artifact.id });
      return `Imported ${artifact.artifactKind} (${formatBytes(local.sizeBytes)}) to this computer.`;
    });

  const uploadArtifact = (artifact: IndexedArtifact) =>
    run(`upload-artifact:${artifact.id}`, async () => {
      if (!organizationId) throw new Error("Choose an organization first.");
      await studioCloud.uploadArtifact({ organizationId, artifactId: artifact.id });
      return `Uploaded ${artifact.artifactKind} (${formatBytes(artifact.byteLength)}) to SimCloud.`;
    });

  const uploadableArtifacts = useMemo(
    () => localArtifacts.filter((artifact) => artifact.artifactState === "available"),
    [localArtifacts],
  );
  const importableArtifacts = useMemo(
    () => cloudArtifacts.filter((artifact) => artifact.artifactState === "available"),
    [cloudArtifacts],
  );

  return (
    <div {...stylex.props(styles.pane)} data-testid="simcloud-storage">
      <div>
      <div {...stylex.props(plate.spread)}>
        <div {...stylex.props(plate.row)}>
          <label {...stylex.props(plate.eyebrow)} htmlFor="simcloud-organization">
            Organization
          </label>
          <select
            id="simcloud-organization"
            {...stylex.props(styles.select)}
            value={organizationId ?? ""}
            onChange={(event) => onOrganizationChange(event.target.value || null)}
            disabled={organizations.length === 0 || busy !== null}
          >
            {organizations.length === 0 ? <option value="">No organizations</option> : null}
            {organizations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} · {ROLE_LABELS[row.role] ?? row.role}
              </option>
            ))}
          </select>
        </div>
        <Button
          xstyle={plate.button}
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading || busy !== null}
          type="button"
        >
          <RefreshCw {...stylex.props(plate.icon, loading && plate.spinner)} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          {...stylex.props(plate.notice, notice.tone === "error" && plate.noticeError)}
        >
          {notice.tone === "error" ? (
            <TriangleAlert {...stylex.props(plate.icon)} aria-hidden="true" />
          ) : (
            <CloudUpload {...stylex.props(plate.icon)} aria-hidden="true" />
          )}
          <span>{notice.text}</span>
        </p>
      ) : null}

      </div>
      <div {...stylex.props(styles.lists)}>
        <ListPlate
          title="Datasets in SimCloud"
          icon={<Database {...stylex.props(plate.icon)} aria-hidden="true" />}
          subtitle={organization ? organization.name : "Choose an organization"}
          empty="This organization has no datasets yet."
          items={cloudDatasets}
          renderItem={(dataset) => {
            const link = linkForRemoteDataset(dataset.id);
            const key = `import-dataset:${dataset.id}`;
            return (
              <Row
                key={dataset.id}
                title={dataset.name}
                detail={`${dataset.documentCount} scenario${dataset.documentCount === 1 ? "" : "s"} · updated ${formatWhen(dataset.updatedAt)}`}
                badge={link ? `Local copy · imported ${formatWhen(link.lastImportedAt)}` : null}
                action={
                  <Button xstyle={plate.button} variant="outline" disabled={busy !== null} onClick={() => void importDataset(dataset)} type="button">
                    {busy === key ? <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" /> : <CloudDownload {...stylex.props(plate.icon)} aria-hidden="true" />}
                    {link ? "Update local copy" : "Import"}
                  </Button>
                }
              />
            );
          }}
        />
        <ListPlate
          title="Datasets on this computer"
          icon={<Database {...stylex.props(plate.icon)} aria-hidden="true" />}
          subtitle="Publish is explicit and all-or-nothing"
          empty="No local datasets yet."
          items={localDatasets}
          renderItem={(dataset) => {
            const link = linkForLocalDataset(dataset.id);
            const linkedHere = link !== null && link.origin === origin && link.remoteOrganizationId === organizationId;
            const key = `publish-dataset:${dataset.id}`;
            const target = publishTargets[dataset.id] ?? (linkedHere ? link.remoteDatasetId : "new");
            return (
              <Row
                key={dataset.id}
                title={dataset.name}
                detail={`${dataset.documentCount} scenario${dataset.documentCount === 1 ? "" : "s"}${linkedHere ? ` · published ${formatWhen(link.lastPublishedAt)}` : ""}`}
                badge={
                  linkedHere
                    ? link.unpublishedDocumentCount > 0
                      ? `${link.unpublishedDocumentCount} unpublished`
                      : `In sync with "${link.remoteDatasetName}"`
                    : link
                      ? "Linked to another organization"
                      : null
                }
                action={
                  <div {...stylex.props(plate.row)}>
                    <select
                      aria-label={`Publish target for ${dataset.name}`}
                      {...stylex.props(styles.select, styles.targetSelect)}
                      value={target}
                      disabled={busy !== null}
                      onChange={(event) => setPublishTargets((current) => ({ ...current, [dataset.id]: event.target.value }))}
                    >
                      {linkedHere ? null : <option value="new">New cloud dataset</option>}
                      {cloudDatasets.map((remote) => (
                        <option key={remote.id} value={remote.id}>
                          Into &quot;{remote.name}&quot;
                        </option>
                      ))}
                    </select>
                    <Button xstyle={plate.button} variant="outline" disabled={busy !== null || dataset.documentCount === 0} onClick={() => void publishDataset(dataset)} type="button">
                      {busy === key ? <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" /> : <CloudUpload {...stylex.props(plate.icon)} aria-hidden="true" />}
                      Publish
                    </Button>
                  </div>
                }
              />
            );
          }}
        />
        <ListPlate
          title="Artifacts in SimCloud"
          icon={<FileBox {...stylex.props(plate.icon)} aria-hidden="true" />}
          subtitle="Render outputs and uploads in this organization"
          empty="This organization has no available artifacts."
          items={importableArtifacts}
          renderItem={(artifact) => {
            const link = linkForRemoteArtifact(artifact.id);
            const key = `import-artifact:${artifact.id}`;
            return (
              <Row
                key={artifact.id}
                title={artifact.artifactKind}
                detail={`${formatBytes(artifact.byteLength)} · ${artifact.mediaType} · ${artifact.renderJobId ? "render output" : "desktop upload"} · ${artifact.sha256.slice(0, 12)}`}
                badge={link ? (link.direction === "upload" ? "Uploaded from here" : "Imported") : null}
                action={
                  <Button xstyle={plate.button} variant="outline" disabled={busy !== null} onClick={() => void importArtifact(artifact)} type="button">
                    {busy === key ? <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" /> : <CloudDownload {...stylex.props(plate.icon)} aria-hidden="true" />}
                    {link ? "Import again" : "Import"}
                  </Button>
                }
              />
            );
          }}
        />
        <ListPlate
          title="Artifacts on this computer"
          icon={<FileBox {...stylex.props(plate.icon)} aria-hidden="true" />}
          subtitle="Only bytes the organization lacks are transferred"
          empty="No local render artifacts yet. Render a scenario first."
          items={uploadableArtifacts}
          renderItem={(artifact) => {
            const link = linkForLocalArtifact(artifact.id);
            const key = `upload-artifact:${artifact.id}`;
            return (
              <Row
                key={artifact.id}
                title={artifact.artifactKind}
                detail={`${formatBytes(artifact.byteLength)} · ${artifact.mediaType} · ${artifact.sha256.slice(0, 12)}`}
                badge={link ? (link.direction === "import" ? "Imported from this organization" : "Uploaded") : null}
                action={
                  <Button xstyle={plate.button} variant="outline" disabled={busy !== null} onClick={() => void uploadArtifact(artifact)} type="button">
                    {busy === key ? <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" /> : <CloudUpload {...stylex.props(plate.icon)} aria-hidden="true" />}
                    {link ? "Upload again" : "Upload"}
                  </Button>
                }
              />
            );
          }}
        />
      </div>
    </div>
  );
}

function ListPlate<T>({
  icon,
  title,
  subtitle,
  empty,
  items,
  renderItem,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  empty: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <section {...stylex.props(plate.root, plate.scroller)}>
      <div>
      <div {...stylex.props(plate.spread)}>
        <div {...stylex.props(plate.row)}>
          {icon}
          <h2 {...stylex.props(plate.title)}>{title}</h2>
        </div>
        <span {...stylex.props(plate.eyebrow)}>{items.length}</span>
      </div>
      <p {...stylex.props(plate.copy, plate.truncate)}>{subtitle}</p>
      </div>
      {items.length === 0 ? (
        <p {...stylex.props(plate.empty)}>{empty}</p>
      ) : (
        <ul {...stylex.props(plate.list, plate.pane)}>{items.map(renderItem)}</ul>
      )}
    </section>
  );
}

function Row({
  title,
  detail,
  badge,
  action,
}: {
  title: string;
  detail: string;
  badge: string | null;
  action: ReactNode;
}) {
  return (
    <li {...stylex.props(plate.item)}>
      <div {...stylex.props(styles.rowBody)}>
        <p {...stylex.props(plate.title, plate.truncate, styles.rowTitle)}>{title}</p>
        <p {...stylex.props(plate.copy, plate.truncate)}>{detail}</p>
        {badge === null ? null : <span {...stylex.props(plate.pill)}>{badge}</span>}
      </div>
      {action}
    </li>
  );
}

