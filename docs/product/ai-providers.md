# AI providers in SimForge Studio

SimForge Studio ships without any AI credentials. Three features call external
AI services and are switched off — with an explicit, actionable message — until
the user configures a provider under **Settings → AI providers**
(`/dashboard/settings/ai-providers`):

| Feature | Where | Provider |
|---|---|---|
| Scene assistant (editor right overlay) | `AssistantChatSlot` → `POST /api/simforge/assistant/stream` | Anthropic key **or** SimCloud assistant |
| AI map search / scenario drafting (map detail page) | `POST /api/map-assets/:id/search/llm` | Anthropic key **or** SimCloud assistant |
| 3D asset generation from photos (Assets → Generate model) | `/api/asset-gallery/generations/**` | Meshy key |

Everything else — local project authoring, keyword map search, rendering,
imports, exports — works without any provider and without a SimCloud account.

## Backends

- **My Anthropic API key** (default). The key is stored by the local service in
  the OS credential vault (`simforge-studio` / `ai-provider:anthropic`). When no
  vault is usable the service keeps it in process memory only and says so; there
  is no plaintext file fallback. Requests go directly from the user's machine
  to Anthropic.
- **SimCloud assistant**. Available only while the app is connected to
  SimCloud **and** an assistant workspace is chosen. The local service keeps
  running the assistant's tools against local maps and documents; only the
  Anthropic Messages call is reverse-proxied by Cloud at
  `POST /api/desktop/ai/anthropic/v1/messages` under the user's native session
  bearer, with `X-SimForge-Workspace-Id` naming the chosen workspace. Cloud
  re-checks membership on every call and attributes the call to that
  workspace; a call without a workspace is refused `400 workspace_required`
  and a workspace the account no longer belongs to is refused
  `403 workspace_forbidden`, both in the Anthropic error envelope. The
  selection is stored per signed-in account, so connecting as a different
  account starts with no workspace rather than inheriting someone else's. The
  desktop never receives or sends a model key; the Cloud route forwards only
  that one endpoint, only `claude-*` models, and answers
  `503 managed_assistant_unavailable` on a deployment without a managed model.
- **Meshy** for asset generation is always bring-your-own. Generated GLBs are
  imported, measured and published into the local asset library exactly like an
  uploaded model.

`ANTHROPIC_API_KEY` / `MESHY_API_KEY` in the service environment are honoured as
a lower-priority source (developer shells, CI); the settings page reports the
key's source and last four characters, never the key.

## Behaviour without a provider

- The assistant stream returns `503 {error:"assistant_unavailable", message}`
  before any streaming starts; the editor panel shows the message with a link
  to settings. There is no echo or placeholder reply.
- AI map search returns `503 {error:"llm_unavailable", message}`; the panel
  shows the message and keyword search stays usable.
- Asset generation returns `503 {error:"gallery_generation_unavailable", message}`
  before reference photos are uploaded; a rejected key or a Meshy balance below
  the floor are reported with their real cause.

## Status and settings API

`GET /api/simforge/ai-providers` → `AiProviderSettingsStatus`
(`studio/app/lib/ai-providers/contracts.ts`). `PATCH` with any of
`assistantBackend`, `anthropicApiKey`, `anthropicModel`, `meshyApiKey`,
`simcloudWorkspace` (`{ workspaceId, workspaceName }`, or `null` to clear; refused
`409 cloud_disconnected` when no account is connected to bind it to); a `null`
key clears it. Keys are write-only.
