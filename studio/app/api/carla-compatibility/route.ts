import { NextResponse } from "next/server";
import { loadCarlaObjectCatalogFile } from "@/app/lib/scenario/carla-object-catalog-file";
import { requireScenarioContext } from "@/app/lib/scenario/http";

/**
 * Which catalog ids can run in CARLA, and with which runtime blueprint.
 *
 * Derived from the generated CARLA object catalog, which is the only place the
 * measurement lives: `objects[]` ARE CARLA blueprints (measured from the
 * shipped UE5 meshes, so their dimensional agreement is exact by
 * construction), `equivalents[]` bind a SimForge catalog model to the CARLA
 * blueprint that stands in for it with the agreement that was measured, and
 * `unavailable[]` records, in the generator's own words, why a model has no
 * blueprint. The same three sources back the Assets > CARLA table, so the
 * editor badge and that table cannot disagree.
 *
 * Absence from all three is NOT reported here as a status: the client treats an
 * unrecorded id as pack-required, which is the honest answer for a model
 * nothing has measured.
 */
const CACHE_CONTROL = "private, max-age=300, must-revalidate";

export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const catalog = await loadCarlaObjectCatalogFile();
  // The catalog is generated from one pinned inventory; its digest is the
  // strongest validator available and changes only when the catalog does.
  const etag = `"carla-compat-${catalog.generatedFrom.inventorySha256.slice(0, 32)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { etag, "cache-control": CACHE_CONTROL } });
  }

  const native: Record<string, { blueprintId: string; dimensionalAgreement: "exact" | "close" | "loose" }> = {};
  for (const object of catalog.objects) {
    native[object.id] = { blueprintId: object.carla.blueprintId, dimensionalAgreement: "exact" };
  }
  for (const equivalent of catalog.equivalents) {
    native[equivalent.catalogId] = {
      blueprintId: equivalent.blueprintId,
      dimensionalAgreement: equivalent.dimensionalAgreement,
    };
  }
  const unavailable: Record<string, string> = {};
  for (const entry of catalog.unavailable) unavailable[entry.catalogId] = entry.reason;

  return NextResponse.json(
    { carlaVersion: catalog.carlaVersion, native, unavailable },
    { headers: { etag, "cache-control": CACHE_CONTROL } },
  );
}
