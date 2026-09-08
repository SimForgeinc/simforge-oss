# AI providers in SimForge Studio

SimForge Studio ships without any AI credentials. One feature calls an external
AI service and is switched off — with an explicit, actionable message — until
the user configures a provider under **Settings → AI providers**
(`/dashboard/settings/ai-providers`):

| Feature | Where | Provider |
|---|---|---|
| 3D asset generation from photos (Assets → Generate model) | `/api/asset-gallery/generations/**` | Meshy key |

Everything else — local project authoring, keyword map search, scenario
editing, rendering, imports, exports — works without any provider and without
a SimCloud account. There is no language-model assistant or AI map search in
the product: scenario authoring is manual and deterministic.

## Backend

- **Meshy** for asset generation is bring-your-own. The key is stored by the
  local service in the OS credential vault (`simforge-studio` /
  `ai-provider:meshy`). When no vault is usable the service keeps it in process
  memory only and says so; there is no plaintext file fallback. Generated GLBs
  are imported, measured and published into the local asset library exactly
  like an uploaded model.

`MESHY_API_KEY` in the service environment is honoured as a lower-priority
source (developer shells, CI); the settings page reports the key's source and
last four characters, never the key.

## Behaviour without a provider

- Asset generation returns `503 {error:"gallery_generation_unavailable", message}`
  before reference photos are uploaded; a rejected key or a Meshy balance below
  the floor are reported with their real cause.

## Status and settings API

`GET /api/simforge/ai-providers` → `AiProviderSettingsStatus`
(`studio/app/lib/ai-providers/contracts.ts`). `PATCH` with `meshyApiKey`; a
`null` key clears it. Keys are write-only.
