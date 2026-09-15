import { NextResponse } from "next/server";
import { loadCarlaObjectCatalogFile } from "@/app/lib/scenario/carla-object-catalog-file";
import { requireScenarioContext } from "@/app/lib/scenario/http";

/**
 * Every measured CARLA object, as catalog entries the editor can place.
 *
 * `objects[]` of the generated catalog are the CARLA blueprints themselves,
 * measured from the shipped UE5 meshes; the client registers each one as an
 * external catalog entry with a proxy mesh, so the dimensions served here are
 * what a person sees and what CARLA spawns. Equivalents and unavailable
 * entries are deliberately NOT included: they are bindings for models that
 * already exist in the SimForge catalog, and belong to
 * `/api/carla-compatibility`, not to a list of placeable CARLA objects.
 */
const CACHE_CONTROL = "private, max-age=300, must-revalidate";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const catalog = await loadCarlaObjectCatalogFile();
  const etag = `"carla-objects-${catalog.generatedFrom.inventorySha256.slice(0, 32)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { etag, "cache-control": CACHE_CONTROL } });
  }

  return NextResponse.json(
    {
      carlaVersion: catalog.carlaVersion,
      objects: catalog.objects.map((object) => ({
        catalogId: object.id,
        label: object.label,
        class: object.class,
        actorClass: object.actorClass,
        dims: object.dims,
        tags: object.tags,
        blueprintId: object.carla.blueprintId,
        ...(object.carla.size === undefined ? {} : { size: object.carla.size }),
      })),
    },
    { headers: { etag, "cache-control": CACHE_CONTROL } },
  );
}
