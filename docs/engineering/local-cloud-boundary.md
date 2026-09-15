# Local / SimCloud boundary

**Status:** design review and cutover proposal (read-only; no implementation in this
change).

This proposal treats the preview as intentionally breakable. There is no released
local-data or API compatibility contract to preserve. The target is one storage
story, one host protocol, and one unambiguous answer to where a run's result lives.

## 1. Current state: verified findings

### 1.1 What the two repositories do today

| Finding | Verified state and consequence |
|---|---|
| Local schema is a SaaS-shaped tenant schema | The OSS tree contains 73 SQL migration files and 88 unique `CREATE TABLE` names. The first migration explicitly calls itself a local subset and omits Better Auth sessions, accounts, invitations, Stripe, and fleet tables (`studio/migrations/0000_auth_workspace_baseline.sql:1-3`). It nevertheless creates `ba_user`, `ba_organization`, `ba_member`, and `workspaces` (`.../0000_auth_workspace_baseline.sql:3-45`). UniScenario then puts `workspace_id` on map versions, documents, revisions, artifacts, render jobs, and related records (`studio/migrations/20260804010000_uniscenario_foundation.sql:8-25,27-80,97-120,202-253`). The earlier audit's 364 `workspace_id` references in 51 migrations is directionally right; a raw token scan also counts comments, constraints, and repeated DDL, so it is not a useful schema-size metric. |
| The “every row is `(workspace_id,id)`” statement needs a correction | The core UniScenario rows are tenant keyed, but the original map catalog is deliberately global: `public.map_assets`, `map_asset_artifacts`, stats, and enrichments have no workspace column (`studio/migrations/0000_auth_workspace_baseline.sql:47-98`). Native map blobs are also content-addressed and global, while native map *sets* are currently workspace-owned (`studio/migrations/20260904010000_native_map_asset_sets.sql:3-35`). Render profiles can be global (`workspace_id IS NULL`) as well as tenant-owned (`studio/migrations/20260804010000_uniscenario_foundation.sql:188-200`). The target must preserve that useful global/catalog distinction without retaining workspaces. |
| Local identity is frozen and synthetic | `LOCAL_USER_ID`, `LOCAL_WORKSPACE_ID`, `LOCAL_ORGANIZATION_ID`, and `LOCAL_SESSION_ID` are constants; every session helper returns the frozen owner session (`studio/app/lib/auth/session.ts:12-41`). The app context then manufactures both workspace and organization IDs for every request (`studio/app/lib/db/app-context.ts:9-40`). This is plumbing, not a meaningful local authorization boundary. |
| Cloud has three names for one tenant choice | OSS DTOs and service calls expose `activeOrganizationId` but data methods take `workspaceId` (`packages/studio-host/src/cloud.ts:14-33,62-65,102-119`). The local connector sends those calls through `/api/simforge/cloud/*` (`packages/studio-host/src/cloud-client.ts:24,51-57,143-171`). Platform context explicitly says active organization is only a hint and that workspace headers/path/body IDs are authoritative (`simcloud-platform/apps/web/app/lib/auth/workspace-context.ts:10-25,67-85,124-145`). The distinction is implemented in foreign-key and membership checks, but it is not a useful product concept. |
| Sync is a third storage system | `cloud_dataset_links`, `cloud_document_links`, and `cloud_artifact_links` retain upstream IDs, remote versions/digests, direction, and conflict fences (`studio/migrations/20260906160000_simforge_cloud_links.sql:1-56`). The transfer code deliberately makes a local working copy and has import/publish 409 semantics (`studio/app/lib/cloud/projects.ts:21-30`). This is a synchronization product, not “local or cloud.” |
| Cloud compute is not cloud render | The compute migration permits only `alpamayo.openloop`, `alpamayo.text`, `alpamayo.closedloop-episode`, and `reconstruct.nurec`; there is no render kind (`simcloud-platform/migrations/20260907130000_simforge_compute_jobs.sql:93-104`). The separate scenario render route exists in both repos (`studio/app/api/simforge/render-jobs/route.ts:12-40`; `simcloud-platform/apps/web/app/api/simforge/render-jobs/route.ts:13-44`). |
| Cloud render already has a coherent output record, but it is workspace-named | A managed render reserves an `artifact_uploads` row and key `${workspace_id}/renders/${job_id}/${attempt_id}/${artifactId}` (`simcloud-platform/apps/web/app/lib/scenario/render-worker-control-store.ts:771-817`). Completion promotes that reservation to `uniscenario.artifacts` and adds an `artifact_links` row with `relationship = 'render_output'` (`.../render-worker-control-store.ts:1189-1229`). The design should keep this render control plane, replacing the tenant segment with organization, rather than inventing a compute render kind. |
| There are duplicate dataset APIs | Platform has the normal `/api/simforge/datasets` list/create route (`simcloud-platform/apps/web/app/api/simforge/datasets/route.ts:20-43`) and a desktop materialization route under `/api/desktop/projects/datasets/[datasetId]` (`.../desktop/projects/datasets/[datasetId]/route.ts:11-30`), plus a separate desktop publish route whose body and conflict contract are working-copy specific (`.../desktop/projects/publish/route.ts:31-45,66-97`). OSS likewise has ordinary `/api/simforge/datasets/*` and cloud import/publish routes (`studio/app/api/simforge/cloud/datasets/route.ts:5-19`; `.../import/route.ts:6-30`; `.../publish/route.ts:10-38`). |
| The worker loop is reusable, with two known local-only input paths | `simforge worker` already requires an explicit HTTP(S) host and bearer token, and passes an optional scratch `--data-root` to the same worker entry point (`packages/cli/src/commands/worker.ts:60-85`). Worker documentation says claims use host-issued URLs, reserve/upload URLs, and fenced completion (`docs/engineering/worker-nodes.md:7-31`). It also names the blockers: native map preparation returns a host directory, `file:` inputs read the worker's own filesystem, and workers must not rely on `SIMFORGE_CLOUD_ROOT` (`docs/engineering/worker-nodes.md:41-61`). |

### 1.2 Material scope that the first audit missed

These are not optional side tables. They decide whether “a scenario” can actually be moved or rendered as one unit.

* **Models and weights.** OSS's local model registry is workspace-scoped and permits an HF identifier, local path, or URL as the checkpoint source (`studio/migrations/20260824180000_simforge_model_registry.sql:3-7,23-41`). Its endpoint descriptor can contain a process command, working directory, or Unix socket (`.../20260824180000_simforge_model_registry.sql:46-70`), and model runs/attempts/events repeat workspace ownership (`.../20260824180000_simforge_model_registry.sql:72-142`). These descriptors cannot be copied verbatim to a hosted worker. Platform model families, versions, and training jobs are likewise workspace-scoped and carry artifact references (`simcloud-platform/migrations/0068_model_platform_foundation.sql:15-73,122-173`).
* **Evaluations and outputs.** Platform model runs reference scenarios, datasets, input/output artifacts, and a cost (`simcloud-platform/migrations/0068_model_platform_foundation.sql:303-357`); evaluation jobs reference model versions/endpoints, dataset snapshots, and report/metrics artifacts (`.../0068_model_platform_foundation.sql:405-451`). A scenario move that omits these leaves results in a third place. They must either move with their owning scenario or be explicitly declared unrelated.
* **Maps.** Published map metadata is shared across authenticated workspaces and anonymous callers get only public maps (`simcloud-platform/apps/web/app/api/simforge/maps/route.ts:5-21`). Map-version artifact pointers were once tenant-blind and had to be made composite to prevent cross-tenant reads (`simcloud-platform/migrations/20260806010000_uniscenario_map_version_artifact_tenancy.sql:11-18,32-43`). The target should make immutable map/blob identity global by digest and make only a map version/set association home-owned.
* **Billing.** Local still has a `billing_ledger` keyed by `workspace_id` (`studio/migrations/0089_billing_ledger_and_default_credits.sql:1-28`), plus credits on both the fake local user and workspace (`studio/migrations/0000_auth_workspace_baseline.sql:3-12,34-45`). Platform model activity adds estimated/actual cost columns and workspace indexes (`simcloud-platform/migrations/0073_cost_ledger_activity_pipeline.sql:1-21,64-71`). Billing is a cloud organization concern; it has no place in an offline local database.
* **Invitations and desktop tokens.** Local reintroduced `ba_invitation` and audit/admin tables in the legacy copy (`studio/migrations/20260822170000_local_legacy_app_schema.sql:3-19,456-520`), even though local identity is frozen. Cloud desktop tokens are random access/refresh values stored only as hashes (`simcloud-platform/apps/web/app/lib/auth/desktop-auth.ts:311-338`); the native session records a requested workspace header and leaves authorization to context resolution (`simcloud-platform/apps/web/app/lib/auth/native-session.ts:1-19,24-55`). The target retains invitations and tokens for cloud account/org membership, but removes them from local data.
* **Object storage.** Local “S3” is a filesystem rooted at `LOCAL_ARTIFACTS_DIR`, and local object URLs are signed `/api/local-objects/...` URLs (`studio/app/lib/s3/s3-object.ts:25-40`; `studio/app/lib/s3/s3-presign.ts:27-44`). This is a storage implementation, not a wire contract. Cloud and local need the same artifact descriptor and reservation protocol, with different storage adapters.

## 2. Target rule: one home, never a mirror

A scenario has exactly one home:

```text
Home = local
     | cloud(organization_id)
```

* **Local** means this Studio installation's daemon and data root. It has no
  account, organization, workspace, membership, or billing rows. The installation
  is the owner boundary; the local process token protects the daemon transport,
  not tenant data.
* **Cloud** means one SimCloud organization. The organization's membership is the
  authorization boundary. There is no workspace row, workspace header, personal
  workspace, or second tenant selector.
* A scenario's authored documents, drafts, revisions, execution packages, input
  artifacts, render history/results, and scenario-linked evaluation/model outputs
  live at that home. A successful render is not copied back to the other home.
* Immutable map blobs and other content-addressed bytes may be physically deduplicated
  globally. That is storage deduplication, not a second scenario home; ownership and
  access still come from the map/scenario association.
* A connected SimCloud account is a capability to select a cloud home. Connecting,
  signing in, or changing the selected organization never uploads, downloads, or
  changes the local scenario home.
* `scenario copy` creates an independent scenario at another home. `scenario move`
  transfers ownership and removes the source only after the destination is committed
  and verified. There are no links, sync versions, import/publish directions, or
  two-sided conflict state.

The server may retain a user ID for cloud provenance (`created_by_user_id`) and
cloud may retain organization membership. Neither is part of the local schema or
client resource identity. Organization context is resolved once by the cloud
request, then every store query uses that context; a resource ID never retargets a
request to another organization.

## 3. Target API and CLI contract

### 3.1 One resource protocol

The same resource paths and DTOs are served by either selected origin:

| Resource | Canonical path | Context behavior |
|---|---|---|
| Capabilities | `GET /api/simforge/host/capabilities` | Local returns installed engines; cloud returns allowed server/worker capabilities. |
| Maps | `GET /api/simforge/maps` and `/maps/:mapVersionId/*` | Public/global map descriptors plus home-authorized map versions. |
| Scenarios/documents | Existing `/api/simforge/documents*`, revisions, imports, and summaries | No tenant field in the body; local origin means local home, cloud origin means the selected organization. |
| Datasets | `/api/simforge/datasets*` | One dataset API; no desktop materialization variant. |
| Artifacts | `/api/simforge/artifacts*` and artifact upload/download routes | Reservation and checksum rules are identical; storage implementation differs. |
| Runs | `/api/simforge/render-jobs*`, `/api/simforge/validation-runs`, model/evaluation run routes | A run is created in the same home as its scenario and result artifacts. |
| Worker control | `/api/simforge/internal/*` | Same claim, lease, heartbeat, reserve, upload, and fenced completion protocol. |

Local and cloud handlers should share the portable OSS behavior and differ only in
persistence, authorization, and storage adapters. This is consistent with the
existing convergence ownership: OSS owns schemas/validation, execution, maps,
render contracts, and training/evaluation protocols; Cloud owns persistence,
authorization, storage, capacity, and hosted jobs (`docs/engineering/simcloud-convergence.md:24-38`).

The request context is deliberately not a new `Home` header:

* The local daemon origin implies `local`; its existing control bearer remains a
  process-to-daemon transport credential.
* A cloud origin's desktop/browser bearer resolves the selected organization after
  a membership check. `--org` selects that organization in the cloud session/profile
  before resource calls; a resource body never carries `workspaceId` or an ad hoc
  tenant ID. Separate concurrent organization operations use separate cloud
  sessions/profiles, not a mutable tenant header.
* `Authorization` is therefore authentication only. It is not accepted as a data
  owner ID, and local control tokens do not cross to SimCloud.
* DTOs remove `workspaceId`, `remoteWorkspaceId`, `cloudOrigin`, and link/version
  fields. A cloud result may include `organizationId` for display, but it is not
  required to address a resource.

### 3.2 Route families to merge and delete

**Keep and make identical on both origins:**

* `/api/simforge/maps*`, `/documents*`, `/datasets*`, `/revisions*`,
  `/execution-packages*`, `/artifacts*`, `/artifact-uploads*`,
  `/render-jobs*`, `/validation-runs`, `/exports*`, `/tags*`, and the scenario
  detail/read routes.
* `/api/simforge/internal/*` worker routes. The just-built worker can continue to
  point at any host that speaks this protocol.
* Cloud-only account operations, kept out of the data plane: desktop OAuth token
  exchange, account/session revocation, organization selection, invitations, and
  disconnect. Rename “active workspace” operations to “active organization.”

**Merge into those canonical routes:**

* Platform `/api/desktop/projects/datasets/*` and `/api/desktop/projects/publish`
  into `/api/simforge/datasets*`. A copy/move endpoint is not a dataset sync
  endpoint and should have an explicit transfer command instead.
* OSS `/api/simforge/cloud/datasets*` and `/cloud/artifacts*` into transfer
  operations in the host client. A selected cloud origin is just another host for
  canonical data routes; it is not a nested `/cloud` API.
* Cloud compute proxy paths into `/api/simforge/compute/*` for compute families
  that are not scenario renders. Scenario rendering remains `/render-jobs*`.

**Delete in the cutover (not aliases):**

* `/api/simforge/cloud/datasets*`, `/cloud/artifacts*`, `/cloud/compute/*`, and
  cloud link-list routes; `cloud_dataset_links`, `cloud_document_links`, and
  `cloud_artifact_links`.
* `/api/desktop/projects/*`, `X-SimForge-Workspace-Id`, every `workspaceId` data
  query/body field, `remoteWorkspaceId`, and the `StudioCloudWorkspace`/workspace
  picker vocabulary. `StudioCloudWorkspace` becomes an organization DTO.
* Local `LOCAL_WORKSPACE_ID`, `LOCAL_ORGANIZATION_ID`, frozen Better Auth session
  plumbing, and all local account/membership/invitation/audit/billing tables.
* Cloud `workspaces`, workspace memberships/context, personal-workspace
  auto-provisioning, and workspace-shaped limits. Platform's current resolver
  makes this split visible: it chooses a workspace from an organization hint and
  membership (`simcloud-platform/apps/web/app/lib/auth/workspace-context.ts:149-227`).
  The replacement resolves an organization membership directly.

### 3.3 CLI verbs

The CLI exposes home explicitly only when a command can cross homes; ordinary
commands default to the scenario's home:

```text
simforge cloud connect [--origin URL]
simforge cloud status
simforge cloud orgs
simforge cloud use-org ORG_ID
simforge cloud disconnect

simforge scenario list [--home local|cloud] [--org ORG_ID]
simforge scenario get SCENARIO_ID [--home ...]
simforge scenario create|edit|delete SCENARIO_ID [--home ...]
simforge scenario copy SCENARIO_ID --to local|cloud [--org ORG_ID]
simforge scenario move SCENARIO_ID --to local|cloud [--org ORG_ID]

simforge render submit SCENARIO_ID [--home ...]
simforge render list|watch|cancel JOB_ID [--home ...]
simforge worker --host HOST --token TOKEN [--capabilities ...]
```

`--home` is an origin/profile selection, not a payload tenant field. `--org` is
required for a cloud destination when the session has no unique active
organization. A local scenario's default render is local. A **cloud render is
only a render of a cloud-home scenario**, so its output is necessarily in that
scenario's organization; the CLI must ask the user to `scenario copy` or `move`
first rather than silently staging a local scenario in an unnamed cloud bucket.

### 3.4 The one obvious cloud-render destination

For a cloud-home scenario, `POST /api/simforge/render-jobs` creates the ordinary
scenario render row. The internal cloud schema uses `organization_id` as its only
tenant column:

1. `uniscenario.render_jobs` stores organization, revision, execution package,
   render spec, idempotency key, and lifecycle state.
2. `uniscenario.render_attempts` stores the attempt and worker lease lineage.
3. `uniscenario.artifact_uploads` reserves each output with the expected digest and
   size.
4. On fenced completion, the server creates/marks `uniscenario.artifacts` as
   available and inserts `uniscenario.artifact_links` with
   `relationship = 'render_output'` and the job/attempt IDs.
5. Every output object has exactly this key:

   ```text
   {organizationId}/renders/{renderJobId}/{attemptId}/{artifactId}
   ```

   The bucket is the cloud render-artifact bucket. This is the existing managed
   key layout with the only tenant name changed (`simcloud-platform/apps/web/app/lib/scenario/render-worker-control-store.ts:771-817`),
   and the existing finalization already creates the artifact/link rows
   (`.../render-worker-control-store.ts:1189-1229`).

The local equivalent uses the local artifact bucket and a key without an
organization prefix, for example
`renders/{renderJobId}/{attemptId}/{artifactId}`. It is served by the local object
route, not presented as an S3 implementation detail. In both cases the render
row's revision is the answer to “which scenario owns this result”; the object key
is only storage addressing.

## 4. Make cloud runs behave like local runs

### 4.1 Desired execution shape

1. The client submits the same render intent to the same route.
2. The host validates the revision, execution package, map closure, model/runtime
   descriptor, and idempotency key.
3. The host creates a durable job and attempt, then leases it to a worker.
4. The worker runs the same OSS engine/renderer and receives checksum-bound input
   URLs. It heartbeats, reserves output objects, uploads them, and completes with
   a fenced manifest.
5. The host verifies bytes, records artifact rows/links, and reports the same job
   state/detail DTO to the client.

Local uses a local worker and filesystem-backed object adapter. Cloud uses the same
worker profile against a Postgres/object-storage-backed host. No client-side
“cloud render” code path and no second render result model are permitted.

Authentication is the only intentional user-visible difference:

* local daemon: per-start control token from the supervisor, with no account or
  organization authorization. The supervisor takes an ownership lock before opening
  PGlite and passes the token to server/worker children (`packages/studio-host/src/node/local-host-supervisor.ts:133-180`).
* cloud: browser or desktop access token, membership in the selected organization,
  and worker bearer capability. Native authentication must still authenticate only;
  authorization belongs to the one organization resolver, as today's native
  session design states (`simcloud-platform/apps/web/app/lib/auth/native-session.ts:6-19`).

### 4.2 Blockers and smallest changes

| Current blocker | Evidence | Smallest target change |
|---|---|---|
| PGlite-first process serialization | The data facade imports both PGlite and `pg`, selects a pool when `DATABASE_URL` exists, but serializes every operation through one global promise (`studio/app/lib/db/data-api.ts:1-4,29-58,209-226`). Transactions already have separate pool/PGlite branches (`.../data-api.ts:250-279`). | Make the database adapter explicit (`local-pglite` or `postgres`), keep serialization only for the local single-process adapter, and let Postgres transactions/pool concurrency handle cloud requests. Do not fork route/store SQL. |
| Native map prep returns a host directory | Native render polls `prepareMap`, receives a directory, then opens and hashes files by local path (`studio/worker/native-render.ts:58-64,113-139,159-190`). The engineering note confirms a remote worker cannot read the host cache (`docs/engineering/worker-nodes.md:46-51`). | Change `prepareMap` to return a checksum-bound member manifest/URLs. Materialize it under the worker's scratch root, then run the existing closure verification and engine code. |
| `file:` input and local paths are not portable | Worker documentation says `file:` inputs read the worker filesystem and are safe only when a packaged closure is installed there (`docs/engineering/worker-nodes.md:52-55`). | Publish every declared closure through the existing artifact/input URL mechanism. Reject `file:` inputs in cloud claims; local may use them only when the local host explicitly owns the path. |
| Misnamed cloud-root and worker scratch settings | Local DB/artifacts are rooted under `SIMFORGE_CLOUD_ROOT` (`studio/app/lib/db/config.ts:5-9`); the worker fallback is `~/.simforge/cloud/worker` (`studio/worker/index.ts:119-123`). | Rename local settings to `SIMFORGE_DATA_ROOT` / `SIMFORGE_LOCAL_WORKER_ROOT` in new code and docs. Cloud workers receive only an ephemeral scratch root and object URLs; no cloud request interprets a filesystem root. |
| Local filesystem presigning is not cloud storage | `getPresignedGetUrl` constructs a local `/api/local-objects/...` URL and signs it (`studio/app/lib/s3/s3-presign.ts:27-44`); object reads/writes resolve to local files (`studio/app/lib/s3/s3-object.ts:32-40,49-70`). | Define one storage adapter interface returning `{bucket,key,url,method,headers,expiresAt}` and digest/size verification. Local adapter uses signed local-object routes; cloud adapter uses object storage. Keep storage coordinates out of portable DTOs except opaque artifact descriptors. |
| Local host is intentionally single-writer | `proper-lockfile` guards the data root before migrations/PGlite startup (`packages/studio-host/src/node/local-host-supervisor.ts:133-180`), and the store additionally takes a transaction advisory lock hashed by workspace (`studio/app/lib/scenario/control-plane-store.ts:698-727`). | Keep the installation ownership lock for local startup. Replace the workspace hash with a job/organization lifecycle key or row lock; do not impose a process-wide single writer on cloud Postgres. |
| Local model descriptors contain machine paths | Endpoint descriptors support `cwd`, process command, and Unix socket path (`studio/migrations/20260824180000_simforge_model_registry.sql:46-70`). | Split descriptor into portable model artifact/runtime digest plus a worker-local launch profile. Local profiles may contain paths; cloud profiles are platform-selected and never accept arbitrary paths from a request. |
| Cloud billing and job limits are mixed into rendering | Cloud render currently maps a workspace limit failure to a billing response (`simcloud-platform/apps/web/app/api/simforge/render-jobs/route.ts:41-49`); compute also reserves/settles workspace credits (`simcloud-platform/migrations/20260907130000_simforge_compute_jobs.sql:1-16`). | Resolve organization entitlement before enqueue, with a named organization error. Keep billing columns/ledger only in cloud. Local enqueue has no credits or billing branch. |

The existing worker protocol is therefore close to the target. The map/file URL
fix and storage adapter are the only data-movement changes required for a cloud
worker; the route, lease, heartbeat, reserve/upload, and evidence model remain the
same.

## 5. Local schema cut: tenant-free baseline

Because the product is unreleased, do not add a long compatibility ladder. Replace
the 73-file local history with one squashed local baseline after exporting any
fixture data that the preview team wants to keep. The baseline has no `workspace_id`
columns and no local identity tables.

### 5.1 Keep (approximately 60–62 tables)

The exact final count depends on whether the still-used map enrichment projections
are folded into the map catalog, but the target groups are:

* UniScenario authored content and lifecycle: map versions, documents, drafts,
  revisions, artifacts, exports, validation runs, execution packages, render
  profiles/jobs/attempts, worker nodes/leases, artifact uploads, job events,
  artifact links, dataset items/datasets, export attempts, asset catalog versions,
  cleanup outbox, browser assets, tags, ratings/preferences, variation transfers,
  editor releases, previews, postprocess jobs, render progress, and the local
  worker credential record.
* Local map catalog and its active enrichment projections:
  `map_assets`, `map_asset_artifacts`, stats, enrichments, buildings, addresses,
  enrichment jobs, and candidate locations. Catalog metadata is global to the
  installation; map versions and native asset-set associations are local-home
  records.
* Local asset gallery: assets, versions, reports, and generation jobs.
* Studio-local model registry and execution ledger: model versions, endpoints,
  model runs/attempts/events, and HiFi preview requests. Strip the tenant column,
  retain model checkpoint digests and local runtime profiles.
* Native map blobs, sets, and members. Blobs remain content-addressed; remove
  ownership from sets and bind them to the local map-version identity.
* The one-row installation setup marker. It already says that `id = 1` represents
  one installation and that its mode is only onboarding state, not access control
  (`studio/migrations/20260911010000_local_studio_setup.sql:7-24`).

The current inventory is 88 unique tables; this keep list is intentionally an
estimate because the cutover should first migrate legacy callers, then remove
obsolete tables rather than preserving them to hit a number.

### 5.2 Delete

Delete these tables and all derived indexes, foreign keys, stores, routes, and
seed data:

* `ba_user`, `ba_organization`, `ba_member`, `ba_invitation`, `workspaces`, and
  `billing_ledger`;
* `workspace_audit_logs`, `admin_role_assignments`, and
  `admin_impersonation_sessions`;
* `simforge.cloud_dataset_links`, `cloud_document_links`, and
  `cloud_artifact_links`;
* the legacy `public.projects`, `public.scenarios`, `public.datasets`,
  `public.dataset_scenarios`, `public.dataset_snapshots`, `public.artifacts`,
  pipeline/export compatibility tables, and other legacy tables that exist only
  to support the old CARLA/workspace product surface. The legacy schema still
  creates those rows (`studio/migrations/20260822170000_local_legacy_app_schema.sql:21-94`),
  so migrate its remaining export/import callers to UniScenario before dropping it.

The local baseline therefore has no Better Auth identity, invitation, account,
organization, workspace, Stripe, credits, audit, cloud-link, or remote-version
concept. Cloud retains organization, member, invitation, account-token, billing,
and audit tables because those are real hosted product concerns.

### 5.3 Drop columns and constraints

For kept local tables, remove:

* `workspace_id` and every workspace composite key/index/foreign key;
* `created_by_user_id`, `updated_by_user_id`, `copied_by_user_id`, and similar
  user foreign keys whose only purpose was hosted provenance;
* `auth_organization_id`, `credits_balance`, Stripe/billing alert columns, and
  cost-reservation fields;
* cloud origin, remote IDs, sync versions, directions, and conflict fences;
* tenant-only checks that compare two workspace IDs.

Keep immutable content identity (`sha256`, byte length, media type, storage key),
render lineage, job idempotency, and artifact relationships. Do not turn a digest
into an ownership key: the same bytes may be reused by multiple local scenarios.
The local data root and local object storage remain one installation boundary, not a
synthetic organization.

### 5.4 Cloud schema counterpart

The cloud migration is the same conceptual cut in the other direction:

* retain `ba_organization`, `ba_member`, invitations, desktop sessions/tokens,
  billing, and audit;
* replace `workspace_id` on scenario, artifact, render, model, evaluation, and
  compute tables with `organization_id`;
* replace composite `(id, workspace_id)` uniqueness and foreign keys with
  organization-aware constraints;
* remove `public.workspaces`, workspace membership/context, personal-workspace
  auto-provisioning, and every workspace header/body field;
* make global map/blob/catalog rows genuinely global, with organization checks only
  on home-owned map versions/sets and scenario references.

This is a database cut, not a compatibility alias. New SQL, routes, DTOs, and
migrations must say organization or no tenant; historical names are not a reason to
retain a dead product concept.

## 6. Transfer semantics, not synchronization

A transfer is an explicit command between two homes. It has no continuously linked
working copy.

### 6.1 Transfer unit

The transfer manifest contains the scenario root, all authored documents/drafts and
revisions, execution packages, map-version references, model references, successful
render/evaluation outputs linked to those revisions, and the content-addressed
artifact closure. Active jobs are not moved: wait for terminal state or cancel and
resubmit at the destination. A model weight is transferred by digest and portable
artifact reference; a local process/cwd/socket descriptor is re-resolved at the
new home.

For each artifact/blob:

1. destination checks `(sha256, byte_length, media_type)`;
2. missing bytes are staged under a temporary transfer key and streamed;
3. destination re-reads and verifies the digest and size;
4. metadata and relationship rows commit only after all required bytes verify;
5. temporary objects are deleted on failure.

Map closures follow the same rule by member path and digest. A missing map member
fails the transfer before the scenario becomes visible.

### 6.2 `copy`

`copy` leaves the source untouched. The destination receives a new scenario/document
identity and rewrites every internal reference through a manifest ID map. Immutable
artifact/map blobs may deduplicate by digest, but destination relationship rows are
new and independently owned. Existing destination names are an ordinary
`name_taken` error; this is not a sync conflict.

### 6.3 `move`

`move` uses the same destination commit and verification as `copy`, then deletes the
source root and its home-owned relationship rows only after the destination commit
is acknowledged. A failed or disconnected transfer leaves the source authoritative
and visible. After success, there is one owner and no tombstone/link table exposed
to the product. A move can preserve IDs when the destination is empty and the
manifest proves no collision; otherwise it remaps IDs exactly as copy does.

### 6.4 What is intentionally absent

There is no import/publish direction, upstream version fence, local draft version,
remote draft version, background sync, “both edited” 409, or cloud-link row. A
409 is reserved for an ordinary destination conflict (name/ID/idempotency), not
for two homes becoming co-authoritative.

## 7. UI consequences

* The top-level home switcher has `Local` and one selected cloud organization.
  It never displays a workspace list. The cloud org selector belongs in account
  settings and organization administration, alongside members/invitations.
* The scenario library is grouped by home. A scenario card shows its home and has
  `Copy to…` and `Move to…`; the transfer dialog displays the destination
  organization, manifest size, missing bytes, and verification result.
* Scenario detail shows one render/evaluation history. The render action defaults
  to the scenario home. There is no “run locally / run in cloud” toggle that can
  detach results; to run in cloud, copy/move the scenario to the cloud organization
  first.
* Cloud account UI owns sign-in, token/session management, organization selection,
  members, invitations, and billing. Local onboarding owns data-root and graphics
  setup only; it never asks the local database to create a user/workspace.
* The current cloud storage page becomes a transfer page. It lists cloud scenarios,
  maps, and artifacts only when the user explicitly chooses the cloud home; it does
  not present a local working-copy/sync status or conflict queue.
* Render detail uses the same job state, attempt, artifact, and download components
  on both origins. A cloud output link opens the cloud object's signed download;
  a local link opens the daemon's signed local-object route.

## 8. Sequenced, independently shippable work

| Step | Owner and scope | Acceptance evidence |
|---|---|---|
| 1. Freeze the boundary contract | **Both repos:** add the shared home/render/transfer wire contract to OSS host contracts and platform API schemas; rename workspace-facing DTOs in the new contract. No route deletion yet. | A fixture can serialize the same scenario, render intent, artifact descriptor, and transfer manifest for local and cloud. No fixture contains `workspaceId`; cloud org is selected by context. |
| 2. Make cloud organization the sole hosted tenant | **Platform:** replace workspace context/membership resolution with organization membership; cut scenario/model/eval/compute rows to `organization_id`; remove personal-workspace provisioning and workspace routes. **OSS host/cloud client:** use organization DTOs and direct canonical cloud origin for resource calls. | An account member can list/create/edit/render only in the selected organization; a non-member receives 403. The same `/api/simforge/datasets` and `/render-jobs` paths work from desktop and browser. No `/api/desktop/projects/*` or workspace header remains. |
| 3. Squash local storage to the offline home | **OSS Studio:** migrate remaining legacy callers, write one tenant-free baseline, remove local auth/billing/audit/invitation/link tables, remove `AppContext.workspaceId/organizationId`, and rename the data-root setting. | Fresh local setup works offline with no SimCloud account. Schema inventory is approximately 60–62 domain tables with zero workspace/auth/billing/link columns. Existing local scenario CRUD, map catalog, model registration, and render listing work through the daemon. |
| 4. Unify execution and storage adapters | **OSS runtime + Platform worker/storage:** retain the render control plane, implement local/cloud artifact adapters, replace map-directory claims with URL manifests, reject cloud `file:` inputs, and use organization render keys. | The same worker binary can render a local job against the daemon and a cloud job against SimCloud. Both produce identical render DTO shape, fenced completion behavior, digest checks, and artifact-link lineage. A cloud output is observable at `{org}/renders/{job}/{attempt}/{artifact}` and belongs to its cloud render row. |
| 5. Ship explicit copy/move | **OSS CLI/UI + Platform transfer endpoints:** implement manifest staging, digest verification, ID remapping, copy, and move; transfer the scenario closure and successful linked outputs; delete all sync link code. | Copy leaves source unchanged and creates an independent destination root. Move removes source only after verified destination commit. A missing map/byte or destination conflict leaves source unchanged. No import/publish/sync status or link table exists. |
| 6. Remove dead surface and re-run boundary audit | **Both repos:** delete cloud proxy data routes, desktop project routes, workspace APIs, aliases, legacy migration callers, and obsolete docs/CLI verbs. Keep only cloud account/org management and canonical data routes. | Route/DTO/schema search finds no new `workspaceId`, workspace header, cloud-link table, or local Better Auth dependency. Offline local operation, cloud org operation, local worker, remote worker, copy, move, and cloud render are exercised end to end. |

Steps 1–3 are independently useful before cloud rendering; step 4 is independently
useful for ordinary cloud jobs; step 5 is independently useful once both homes
exist. Step 6 is cleanup after the behavioral smoke paths pass, not a compatibility
phase.

## 9. Rejected alternatives

1. **Keep workspace and call it an organization alias.** Rejected. The current
   platform already has organization hints, workspace authority, workspace headers,
   composite foreign keys, personal-workspace provisioning, and workspace DTOs
   (`simcloud-platform/apps/web/app/lib/auth/workspace-context.ts:10-25,174-227`).
   An alias leaves every route, query, and UI picker with two names and preserves
   the exact ambiguity this cutover is meant to remove.
2. **Keep import/publish links and improve conflict handling.** Rejected. The link
   migration explicitly creates remote-version/digest fences and three link tables
   (`studio/migrations/20260906160000_simforge_cloud_links.sql:1-56`). That is a
   third product (sync), not a simple local-vs-cloud home. It also makes a cloud
   render's ownership unclear when a local working copy diverges.
3. **Make cloud a second compute API while scenarios remain local.** Rejected.
   Cloud compute currently has no render kind (`simcloud-platform/migrations/20260907130000_simforge_compute_jobs.sql:93-104`),
   while scenario renders already have a durable job/attempt/artifact/link model.
   Splitting scenario data and render results recreates the “where did it go?”
   problem and forces a second input/authorization protocol.
4. **Allow `render --cloud` to stage a local scenario ephemerally.** Rejected.
   It produces an output with no obvious scenario home, invites accidental uploads
   on a render command, and makes retry/delete semantics ambiguous. Copy or move is
   the explicit boundary; cloud render then always belongs to the cloud-home
   scenario and organization.
5. **Share one database/object bucket between local and cloud.** Rejected.
   Local objects are filesystem paths and local signed routes (`studio/app/lib/s3/s3-object.ts:32-40`; `studio/app/lib/s3/s3-presign.ts:27-44`),
   whereas cloud output keys, leases, and authorization are durable hosted records
   (`simcloud-platform/apps/web/app/lib/scenario/render-worker-control-store.ts:771-817,1189-1229`).
   Shared physical storage would couple offline operation to cloud credentials and
   turn a storage optimization into an authorization boundary.
6. **Retain local Better Auth/credits tables “for future compatibility.”** Rejected.
   The local session is frozen regardless of request (`studio/app/lib/auth/session.ts:27-41`),
   and local billing is workspace-shaped (`studio/migrations/0089_billing_ledger_and_default_credits.sql:1-28`).
   Keeping those tables adds migration and failure modes without enabling a real
   local account or billing behavior.
