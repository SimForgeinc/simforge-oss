import type { ScenarioArtifactDto, ScenarioDatasetDto, WorkspaceArtifact } from "./contracts";

/** Connection identity is independent of local project ownership and compute. */
export type StudioCloudUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type StudioCloudStatus = {
  state: "disconnected" | "connecting" | "connected" | "expired" | "error";
  origin: string;
  user: StudioCloudUser | null;
  credentialPersistence: "os-vault" | "session";
  /** Expiry of the server-issued session, not a renderer-created access grant. */
  sessionExpiresAt: string | null;
  message: string | null;
};

export type StudioCloudWorkspace = {
  id: string;
  name: string;
  role: string;
};

export type StudioCloudDatasetRef = {
  workspaceId: string;
  datasetId: string;
};

export type StudioCloudPublishResult = {
  workspaceId: string;
  datasetId: string;
  documents: number;
  artifacts: number;
};

/**
 * The installed app's local Cloud connector. Tokens never cross this API.
 * Opening Cloud content makes an explicit local working copy; connecting
 * alone never uploads data or changes the selected execution target.
 */
export interface StudioCloudService {
  status(signal?: AbortSignal): Promise<StudioCloudStatus>;
  connect(options?: { origin?: string }, signal?: AbortSignal): Promise<{ authorizationUrl: string }>;
  disconnect(signal?: AbortSignal): Promise<StudioCloudStatus>;
  listWorkspaces(signal?: AbortSignal): Promise<StudioCloudWorkspace[]>;
  listDatasets(workspaceId: string, signal?: AbortSignal): Promise<ScenarioDatasetDto[]>;
  importDataset(source: StudioCloudDatasetRef, signal?: AbortSignal): Promise<ScenarioDatasetDto>;
  publishDataset(
    input: { datasetId: string; workspaceId: string; remoteDatasetId?: string },
    signal?: AbortSignal,
  ): Promise<StudioCloudPublishResult>;
  listArtifacts(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceArtifact[]>;
  importArtifact(
    source: { workspaceId: string; artifactId: string },
    signal?: AbortSignal,
  ): Promise<ScenarioArtifactDto>;
  uploadArtifact(
    input: { artifactId: string; workspaceId: string },
    signal?: AbortSignal,
  ): Promise<{ workspaceId: string; artifactId: string }>;
}
