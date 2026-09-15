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
 * One SimCloud tenant this account belongs to — a cloud home.
 *
 * `id` is the identifier the Cloud accepts to act in that tenant. Today the
 * deployed desktop surface enumerates tenants as workspace rows
 * (`/api/desktop/projects/workspaces` selects `w.id, w.name, m.role` and
 * exposes no organization id at all), so this `id` is a platform *workspace*
 * row id naming the tenant, not `workspaces.auth_organization_id`. It is
 * carried opaquely and only ever handed back to the Cloud through the one
 * legacy adapter in `studio/app/lib/cloud/connection.ts`. It becomes a real
 * organization id when the platform half of
 * `docs/engineering/local-cloud-boundary.md` §8 step 2 lands; until then do not
 * compare it with `StudioCloudStatus.activeOrganizationId`, which IS an
 * organization id (`desktop_sessions.active_organization_id`).
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
