import catalogFile from "@/app/generated/carla-object-catalog.json";
import type { CarlaCompatibility } from "@simforge-oss/studio-ui/lib/scenario/carla-compatibility";
import type { CarlaCompatibilityRow } from "./CarlaCompatibilityTable";

interface Dimensions {
  l: number;
  w: number;
  h: number;
}

interface CarlaCatalogFile {
  carlaVersion: string;
  counts: {
    objects: number;
    equivalents: number;
    unavailable: number;
  };
  objects: Array<{
    id: string;
    label: string;
    class: string;
    dims: Dimensions;
    carla: { blueprintId: string };
  }>;
  equivalents: Array<{
    catalogId: string;
    blueprintId: string;
    authoredDims: Dimensions;
    dimensionalAgreement: "exact" | "close" | "loose";
  }>;
  unavailable: Array<{
    catalogId: string;
    class: string;
    reason: string;
  }>;
}

function formatDimensions(dims: Dimensions) {
  return `${dims.l.toFixed(2)} × ${dims.w.toFixed(2)} × ${dims.h.toFixed(2)} m`;
}

function labelFromCatalogId(catalogId: string) {
  const name = catalogId.split(".").at(-1) ?? catalogId;
  const words = name.replaceAll("_", " ");
  return words.replace(/^./, (letter) => letter.toUpperCase());
}

function nativeCompatibility(
  blueprintId: string,
  dimensionalAgreement: "exact" | "close" | "loose",
): CarlaCompatibility {
  return { status: "native", blueprintId, dimensionalAgreement };
}

// The catalog is bundled, never read from disk: the repo-root JSON is not
// traced into a serverless bundle and threw in every deployed environment.
export const catalog = catalogFile as unknown as CarlaCatalogFile;

export function buildRows(catalog: CarlaCatalogFile): CarlaCompatibilityRow[] {
  const rows: CarlaCompatibilityRow[] = [
    ...catalog.objects.map((object) => ({
      catalogId: object.id,
      label: object.label,
      source: `CARLA ${catalog.carlaVersion}`,
      objectClass: object.class,
      dimensions: formatDimensions(object.dims),
      compatibility: nativeCompatibility(object.carla.blueprintId, "exact"),
    })),
    ...catalog.equivalents.map((equivalent) => ({
      catalogId: equivalent.catalogId,
      label: labelFromCatalogId(equivalent.catalogId),
      source: "SimForge catalog",
      objectClass: equivalent.catalogId.split(".", 1)[0] ?? "catalog",
      dimensions: formatDimensions(equivalent.authoredDims),
      compatibility: nativeCompatibility(equivalent.blueprintId, equivalent.dimensionalAgreement),
    })),
    ...catalog.unavailable.map((unavailable) => ({
      catalogId: unavailable.catalogId,
      label: labelFromCatalogId(unavailable.catalogId),
      source: "SimForge catalog",
      objectClass: unavailable.class,
      dimensions: null,
      compatibility: {
        status: "generated-pack" as const,
        reason: unavailable.reason,
      },
    })),
  ];

  return rows.sort((left, right) => {
    const leftRank = left.compatibility.status === "native" ? 0 : 1;
    const rightRank = right.compatibility.status === "native" ? 0 : 1;
    return leftRank - rightRank || left.label.localeCompare(right.label) || left.catalogId.localeCompare(right.catalogId);
  });
}

