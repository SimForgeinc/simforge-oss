"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  Cloud,
  CloudDownload,
  CloudUpload,
  Database,
  FileBox,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type {
  ScenarioDatasetDto,
  StudioCloudWorkspace,
  WorkspaceArtifact,
} from "@simforge-oss/studio-host";
import { StudioHostRequestError } from "@simforge-oss/studio-host";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Badge } from "@simforge-oss/studio-ui/components/ui/badge";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { EmptyState } from "@simforge-oss/studio-ui/components/ui/empty-state";
import { PageHeader } from "@simforge-oss/studio-ui/components/ui/page-header";
import { styles } from "@/app/components/cloud-storage/cloud-storage.stylex";
import { studioHost } from "@/app/lib/host";
import { studioCloud, useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * Cloud Storage: what a SimCloud workspace holds next to what this computer
 * holds, with explicit import/publish/upload actions between them.
 *
 * Every transfer is an intentional click. Link records (read from the local
 * service, no connection needed) show which local datasets and artifacts are
 * working copies of cloud content and whether local edits are still
 * unpublished. Conflicts come back as messages naming the scenarios; the page
 * never resolves them on its own.
 */

type CloudDatasetLink = {
  localDatasetId: string;
  origin: string;
  remoteWorkspaceId: string;
  remoteDatasetId: string;
  remoteDatasetName: string;
  lastImportedAt: string | null;
  lastPublishedAt: string | null;
  unpublishedDocumentCount: number;
};

type CloudArtifactLink = {
  localArtifactId: string;
  origin: string;
  remoteWorkspaceId: string;
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

function describeError(reason: unknown, fallback: string): string {
  if (reason instanceof StudioHostRequestError) return reason.message || `${fallback} (${reason.code})`;
  if (reason instanceof Error && reason.message) return reason.message;
  return fallback;
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

export function CloudStoragePanel() {
  useSetPageTitle("Cloud Storage");
  const cloud = useStudioCloudStatus();
  const connected = cloud.status?.state === "connected";

  const [workspaces, setWorkspaces] = useState<StudioCloudWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [cloudDatasets, setCloudDatasets] = useState<ScenarioDatasetDto[]>([]);
  const [cloudArtifacts, setCloudArtifacts] = useState<WorkspaceArtifact[]>([]);
  const [localDatasets, setLocalDatasets] = useState<ScenarioDatasetDto[]>([]);
  const [localArtifacts, setLocalArtifacts] = useState<WorkspaceArtifact[]>([]);
  const [datasetLinks, setDatasetLinks] = useState<CloudDatasetLink[]>([]);
  const [artifactLinks, setArtifactLinks] = useState<CloudArtifactLink[]>([]);
  const [publishTargets, setPublishTargets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const workspace = useMemo(
    () => workspaces.find((candidate) => candidate.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );
  const origin = cloud.status?.origin ?? null;

  const loadLocal = useCallback(async () => {
    const [datasets, artifacts, datasetLinkRows, artifactLinkRows] = await Promise.all([
      studioHost.projects.listDatasets(),
      studioHost.artifacts.listWorkspaceArtifacts({ limit: 200 }),
      readLinks<CloudDatasetLink>("/api/simforge/cloud/datasets/links"),
      readLinks<CloudArtifactLink>("/api/simforge/cloud/artifacts/links"),
    ]);
    setLocalDatasets(datasets);
    setLocalArtifacts(artifacts);
    setDatasetLinks(datasetLinkRows);
    setArtifactLinks(artifactLinkRows);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const rows = await studioCloud.listWorkspaces();
    setWorkspaces(rows);
    setWorkspaceId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
  }, []);

  const loadWorkspaceContent = useCallback(async (id: string) => {
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
      if (connected) {
        await loadWorkspaces();
      } else {
        setWorkspaces([]);
        setCloudDatasets([]);
        setCloudArtifacts([]);
      }
    } catch (reason) {
      setNotice({ tone: "error", text: describeError(reason, "Cloud storage could not be loaded.") });
    } finally {
      setLoading(false);
    }
  }, [connected, loadLocal, loadWorkspaces]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!connected || !workspaceId) return;
    let cancelled = false;
    setLoading(true);
    loadWorkspaceContent(workspaceId)
      .catch((reason: unknown) => {
        if (!cancelled) setNotice({ tone: "error", text: describeError(reason, "Workspace content could not be loaded.") });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, workspaceId, loadWorkspaceContent]);

  const linkForRemoteDataset = useCallback(
    (remoteDatasetId: string) =>
      datasetLinks.find(
        (link) => link.origin === origin && link.remoteWorkspaceId === workspaceId && link.remoteDatasetId === remoteDatasetId,
      ) ?? null,
    [datasetLinks, origin, workspaceId],
  );
  const linkForLocalDataset = useCallback(
    (localDatasetId: string) => datasetLinks.find((link) => link.localDatasetId === localDatasetId) ?? null,
    [datasetLinks],
  );
  const linkForRemoteArtifact = useCallback(
    (remoteArtifactId: string) =>
      artifactLinks.find(
        (link) => link.origin === origin && link.remoteWorkspaceId === workspaceId && link.remoteArtifactId === remoteArtifactId,
      ) ?? null,
    [artifactLinks, origin, workspaceId],
  );
  const linkForLocalArtifact = useCallback(
    (localArtifactId: string) =>
      artifactLinks.find(
        (link) => link.origin === origin && link.remoteWorkspaceId === workspaceId && link.localArtifactId === localArtifactId,
      ) ?? null,
    [artifactLinks, origin, workspaceId],
  );

  async function run(key: string, action: () => Promise<string>) {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    try {
      const text = await action();
      setNotice({ tone: "success", text });
      await loadLocal();
      if (workspaceId) await loadWorkspaceContent(workspaceId);
    } catch (reason) {
      setNotice({ tone: "error", text: describeError(reason, "The transfer failed.") });
    } finally {
      setBusy(null);
    }
  }

  const importDataset = (dataset: ScenarioDatasetDto) =>
    run(`import-dataset:${dataset.id}`, async () => {
      if (!workspaceId) throw new Error("Choose a workspace first.");
      const local = await studioCloud.importDataset({ workspaceId, datasetId: dataset.id });
      return `"${dataset.name}" is now a local working copy (${local.documentCount} scenario${local.documentCount === 1 ? "" : "s"}, dataset "${local.name}").`;
    });

  const publishDataset = (dataset: ScenarioDatasetDto) =>
    run(`publish-dataset:${dataset.id}`, async () => {
      if (!workspaceId) throw new Error("Choose a workspace first.");
      const link = linkForLocalDataset(dataset.id);
      const chosen = publishTargets[dataset.id];
      const remoteDatasetId =
        chosen === "new" ? undefined : chosen ?? (link && link.remoteWorkspaceId === workspaceId && link.origin === origin ? link.remoteDatasetId : undefined);
      const result = await studioCloud.publishDataset({ datasetId: dataset.id, workspaceId, remoteDatasetId });
      return result.documents === 0
        ? `"${dataset.name}" is already up to date in SimCloud.`
        : `Published ${result.documents} scenario${result.documents === 1 ? "" : "s"} from "${dataset.name}" to SimCloud.`;
    });

  const importArtifact = (artifact: WorkspaceArtifact) =>
    run(`import-artifact:${artifact.id}`, async () => {
      if (!workspaceId) throw new Error("Choose a workspace first.");
      const local = await studioCloud.importArtifact({ workspaceId, artifactId: artifact.id });
      return `Imported ${artifact.artifactKind} (${formatBytes(local.sizeBytes)}) to this computer.`;
    });

  const uploadArtifact = (artifact: WorkspaceArtifact) =>
    run(`upload-artifact:${artifact.id}`, async () => {
      if (!workspaceId) throw new Error("Choose a workspace first.");
      await studioCloud.uploadArtifact({ workspaceId, artifactId: artifact.id });
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
    <div {...stylex.props(styles.shell)}>
      <PageHeader
        eyebrow="SimCloud"
        title="Cloud Storage"
        description="Import cloud datasets and artifacts as local working copies, and publish or upload local work when you decide to."
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || busy !== null}>
            <RefreshCw {...stylex.props(styles.icon, loading && styles.spinner)} />
            Refresh
          </Button>
        }
      />

      {!connected ? (
        <EmptyState
          title="Connect to SimCloud to use cloud storage"
          icon={<Cloud {...stylex.props(styles.icon8)} />}
          description={
            cloud.status?.state === "expired"
              ? "Your SimCloud session has expired. Connect again to browse your workspaces. Nothing on this computer is affected."
              : "Everything on this computer keeps working without an account. Connecting lets you browse your workspaces and move projects and artifacts explicitly — nothing is uploaded on sign-in."
          }
          action={
            <Button onClick={() => void cloud.connect()} disabled={cloud.loading}>
              {cloud.loading ? <LoaderCircle {...stylex.props(styles.icon4, styles.spinner)} /> : <Cloud {...stylex.props(styles.icon4)} />}
              {cloud.status?.state === "connecting" ? "Waiting for your browser…" : "Connect to SimCloud"}
            </Button>
          }
        />
      ) : (
        <div {...stylex.props(styles.content)}>
          <div {...stylex.props(styles.workspaceBar)}>
            <label {...stylex.props(styles.label)} htmlFor="cloud-storage-workspace">
              Workspace
            </label>
            <select
              id="cloud-storage-workspace"
              {...stylex.props(styles.select)}
              value={workspaceId ?? ""}
              onChange={(event) => setWorkspaceId(event.target.value || null)}
              disabled={workspaces.length === 0 || busy !== null}
            >
              {workspaces.length === 0 ? <option value="">No workspaces</option> : null}
              {workspaces.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {ROLE_LABELS[row.role] ?? row.role}
                </option>
              ))}
            </select>
            {workspace ? (
              <span {...stylex.props(styles.account)}>
                {cloud.status?.user?.email ?? cloud.status?.user?.name ?? "Signed in"} · {origin}
              </span>
            ) : null}
          </div>

          {notice ? (
            <div
              role={notice.tone === "error" ? "alert" : "status"}
              {...stylex.props(styles.notice, notice.tone === "success" && styles.noticeSuccess)}
            >
              {notice.tone === "error" ? <TriangleAlert {...stylex.props(styles.noticeIcon)} /> : <Cloud {...stylex.props(styles.noticeIcon)} />}
              <span>{notice.text}</span>
            </div>
          ) : null}

          <section {...stylex.props(styles.sectionGrid)}>
            <ListCard
              title="Datasets in SimCloud"
              icon={<Database {...stylex.props(styles.icon4)} />}
              subtitle={workspace ? workspace.name : "Choose a workspace"}
              empty="This workspace has no datasets yet."
              items={cloudDatasets}
              renderItem={(dataset) => {
                const link = linkForRemoteDataset(dataset.id);
                const key = `import-dataset:${dataset.id}`;
                return (
                  <Row
                    key={dataset.id}
                    title={dataset.name}
                    detail={`${dataset.documentCount} scenario${dataset.documentCount === 1 ? "" : "s"} · updated ${formatWhen(dataset.updatedAt)}`}
                    badge={link ? <Badge variant="secondary">Local copy · imported {formatWhen(link.lastImportedAt)}</Badge> : null}
                    action={
                      <Button size="sm" variant={link ? "outline" : "default"} disabled={busy !== null} onClick={() => void importDataset(dataset)}>
                        {busy === key ? <LoaderCircle {...stylex.props(styles.icon, styles.spinner)} /> : <CloudDownload {...stylex.props(styles.icon)} />}
                        {link ? "Update local copy" : "Import"}
                      </Button>
                    }
                  />
                );
              }}
            />
            <ListCard
              title="Datasets on this computer"
              icon={<Database {...stylex.props(styles.icon4)} />}
              subtitle="Publish is explicit and all-or-nothing"
              empty="No local datasets yet."
              items={localDatasets}
              renderItem={(dataset) => {
                const link = linkForLocalDataset(dataset.id);
                const linkedHere = link !== null && link.origin === origin && link.remoteWorkspaceId === workspaceId;
                const key = `publish-dataset:${dataset.id}`;
                const target = publishTargets[dataset.id] ?? (linkedHere ? link.remoteDatasetId : "new");
                return (
                  <Row
                    key={dataset.id}
                    title={dataset.name}
                    detail={`${dataset.documentCount} scenario${dataset.documentCount === 1 ? "" : "s"}${linkedHere ? ` · published ${formatWhen(link.lastPublishedAt)}` : ""}`}
                    badge={
                      linkedHere ? (
                        link.unpublishedDocumentCount > 0 ? (
                          <Badge variant="destructive">{link.unpublishedDocumentCount} unpublished</Badge>
                        ) : (
                          <Badge variant="secondary">In sync with "{link.remoteDatasetName}"</Badge>
                        )
                      ) : link ? (
                        <Badge variant="outline">Linked to another workspace</Badge>
                      ) : null
                    }
                    action={
                      <div {...stylex.props(styles.actions)}>
                        <select
                          aria-label={`Publish target for ${dataset.name}`}
                          {...stylex.props(styles.targetSelect)}
                          value={target}
                          disabled={busy !== null}
                          onChange={(event) => setPublishTargets((current) => ({ ...current, [dataset.id]: event.target.value }))}
                        >
                          {linkedHere ? null : <option value="new">New cloud dataset</option>}
                          {cloudDatasets.map((remote) => (
                            <option key={remote.id} value={remote.id}>
                              Into "{remote.name}"
                            </option>
                          ))}
                        </select>
                        <Button size="sm" variant={linkedHere ? "outline" : "default"} disabled={busy !== null || dataset.documentCount === 0} onClick={() => void publishDataset(dataset)}>
                          {busy === key ? <LoaderCircle {...stylex.props(styles.icon, styles.spinner)} /> : <CloudUpload {...stylex.props(styles.icon)} />}
                          Publish
                        </Button>
                      </div>
                    }
                  />
                );
              }}
            />
          </section>

          <section {...stylex.props(styles.sectionGrid)}>
            <ListCard
              title="Artifacts in SimCloud"
              icon={<FileBox {...stylex.props(styles.icon4)} />}
              subtitle="Render outputs and uploads in this workspace"
              empty="This workspace has no available artifacts."
              items={importableArtifacts}
              renderItem={(artifact) => {
                const link = linkForRemoteArtifact(artifact.id);
                const key = `import-artifact:${artifact.id}`;
                return (
                  <Row
                    key={artifact.id}
                    title={artifact.artifactKind}
                    detail={`${formatBytes(artifact.byteLength)} · ${artifact.mediaType} · ${artifact.renderJobId ? "render output" : "desktop upload"} · ${artifact.sha256.slice(0, 12)}`}
                    badge={link ? <Badge variant="secondary">{link.direction === "upload" ? "Uploaded from here" : "Imported"}</Badge> : null}
                    action={
                      <Button size="sm" variant={link ? "outline" : "default"} disabled={busy !== null} onClick={() => void importArtifact(artifact)}>
                        {busy === key ? <LoaderCircle {...stylex.props(styles.icon, styles.spinner)} /> : <CloudDownload {...stylex.props(styles.icon)} />}
                        {link ? "Import again" : "Import"}
                      </Button>
                    }
                  />
                );
              }}
            />
            <ListCard
              title="Artifacts on this computer"
              icon={<FileBox {...stylex.props(styles.icon4)} />}
              subtitle="Only bytes the workspace lacks are transferred"
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
                    badge={link ? <Badge variant="secondary">{link.direction === "import" ? "Imported from this workspace" : "Uploaded"}</Badge> : null}
                    action={
                      <Button size="sm" variant={link ? "outline" : "default"} disabled={busy !== null} onClick={() => void uploadArtifact(artifact)}>
                        {busy === key ? <LoaderCircle {...stylex.props(styles.icon, styles.spinner)} /> : <CloudUpload {...stylex.props(styles.icon)} />}
                        {link ? "Upload again" : "Upload"}
                      </Button>
                    }
                  />
                );
              }}
            />
          </section>
        </div>
      )}
    </div>
  );
}

function ListCard<T>({
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
    <div {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.cardHeader)}>
        <span {...stylex.props(styles.cardIcon)}>{icon}</span>
        <div {...stylex.props(styles.cardHeading)}>
          <h2 {...stylex.props(styles.cardTitle)}>{title}</h2>
          <p {...stylex.props(styles.cardSubtitle)}>{subtitle}</p>
        </div>
        <span {...stylex.props(styles.count)}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p {...stylex.props(styles.empty)}>{empty}</p>
      ) : (
        <ul {...stylex.props(styles.list)}>{items.map(renderItem)}</ul>
      )}
    </div>
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
  badge: ReactNode;
  action: ReactNode;
}) {
  return (
    <li {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowBody)}>
        <div {...stylex.props(styles.rowHeading)}>
          <span {...stylex.props(styles.rowTitle)}>{title}</span>
          {badge}
        </div>
        <p {...stylex.props(styles.rowDetail)}>{detail}</p>
      </div>
      {action}
    </li>
  );
}
