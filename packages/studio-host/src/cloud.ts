import type { IndexedArtifact, ScenarioArtifactDto, ScenarioDatasetDto } from "./contracts";

/** Connection identity is independent of local project ownership and compute. */
export type StudioCloudUser = {
  id: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
};

/** Social sign-in providers the Cloud has configured; the only flows that leave the app. */
export type StudioCloudProvider = "google" | "github";

export type StudioCloudStatus = {
  /** `connecting` is the social hop only: the system browser holds the flow. */
  state: "disconnected" | "connecting" | "connected" | "expired" | "error";
  origin: string;
  user: StudioCloudUser | null;
  /** The organization this sign-in acts in; `null` until the account reports one. */
  activeOrganizationId: string | null;
  providers: StudioCloudProvider[];
  credentialPersistence: "os-vault" | "session";
  /** Expiry of the server-issued session, not a renderer-created access grant. */
  sessionExpiresAt: string | null;
  message: string | null;
};

/**
 * One SimCloud organization this account belongs to. `id` is the organization
 * id: a cloud home has exactly one tenant and this is it.
 */
export type StudioCloudOrganization = {
  id: string;
  name: string;
  role: string;
};

/** One signed-in device of the account, as the Cloud lists it. */
export type StudioCloudSession = {
  id: string;
  label: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  active: boolean;
  /** The session this installation holds. */
  current: boolean;
};

export type StudioCloudAccount = {
  user: StudioCloudUser;
  activeOrganizationId: string | null;
  sessions: StudioCloudSession[];
};

export type StudioCloudInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  role: string;
  inviterEmail: string | null;
  expiresAt: string;
};

export type StudioCloudDatasetRef = {
  organizationId: string;
  datasetId: string;
};

export type StudioCloudPublishResult = {
  organizationId: string;
  datasetId: string;
  documents: number;
  artifacts: number;
};

/**
 * The installed app's local Cloud connector. Tokens never cross this API.
 * Every account flow is native: the renderer posts forms to the local
 * service, which speaks to SimCloud; only `connect` (Google/GitHub) leaves
 * the app for the system browser. Opening Cloud content makes an explicit
 * local working copy; signing in alone never uploads data or changes the
 * selected execution target.
 */
export interface StudioCloudService {
  status(signal?: AbortSignal): Promise<StudioCloudStatus>;
  /** Social sign-in: the renderer opens `authorizationUrl` in the system browser and polls `status`. */
  connect(options: { provider: StudioCloudProvider; origin?: string }, signal?: AbortSignal): Promise<{ authorizationUrl: string }>;
  signIn(input: { email: string; password: string }, signal?: AbortSignal): Promise<StudioCloudStatus>;
  signUp(input: { email: string; password: string; name: string }, signal?: AbortSignal): Promise<StudioCloudStatus>;
  verifyEmail(input: { code: string }, signal?: AbortSignal): Promise<StudioCloudStatus>;
  resendVerification(signal?: AbortSignal): Promise<StudioCloudStatus>;
  forgotPassword(input: { email: string }, signal?: AbortSignal): Promise<{ ok: true }>;
  /** Succeeding signs this installation out too: the Cloud revokes every session of the account. */
  resetPassword(input: { email: string; code: string; newPassword: string }, signal?: AbortSignal): Promise<StudioCloudStatus>;
  changePassword(input: { currentPassword: string; newPassword: string }, signal?: AbortSignal): Promise<{ ok: true }>;
  account(signal?: AbortSignal): Promise<StudioCloudAccount>;
  updateAccount(input: { name: string }, signal?: AbortSignal): Promise<StudioCloudAccount>;
  revokeSession(id: string, signal?: AbortSignal): Promise<{ ok: true }>;
  listInvitations(signal?: AbortSignal): Promise<StudioCloudInvitation[]>;
  acceptInvitation(id: string, signal?: AbortSignal): Promise<{ organizationId: string }>;
  declineInvitation(id: string, signal?: AbortSignal): Promise<{ ok: true }>;
  /** `token` is the invite token or the whole invite URL from the email. */
  acceptInvitationLink(token: string, signal?: AbortSignal): Promise<{ organizationId: string }>;
  setActiveOrganization(organizationId: string, signal?: AbortSignal): Promise<StudioCloudStatus>;
  disconnect(signal?: AbortSignal): Promise<StudioCloudStatus>;
  listOrganizations(signal?: AbortSignal): Promise<StudioCloudOrganization[]>;
  listDatasets(organizationId: string, signal?: AbortSignal): Promise<ScenarioDatasetDto[]>;
  importDataset(source: StudioCloudDatasetRef, signal?: AbortSignal): Promise<ScenarioDatasetDto>;
  publishDataset(
    input: { datasetId: string; organizationId: string; remoteDatasetId?: string },
    signal?: AbortSignal,
  ): Promise<StudioCloudPublishResult>;
  listArtifacts(organizationId: string, signal?: AbortSignal): Promise<IndexedArtifact[]>;
  importArtifact(
    source: { organizationId: string; artifactId: string },
    signal?: AbortSignal,
  ): Promise<ScenarioArtifactDto>;
  uploadArtifact(
    input: { artifactId: string; organizationId: string },
    signal?: AbortSignal,
  ): Promise<{ organizationId: string; artifactId: string }>;
}
