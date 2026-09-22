import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import {
  CARLA_PEDESTRIAN_MODELS,
  CARLA_VEHICLE_MODELS,
  PROP_TAGS,
  registerExternalCatalogEntry,
  type CatalogActorClass,
  type Dims,
  type ExternalCatalogEntry,
  type PropClass,
  type PropTag,
} from "@simforge-oss/asset-catalog";

export interface CarlaObjectDto {
  readonly catalogId: string;
  readonly label: string;
  readonly class: PropClass;
  readonly actorClass: CatalogActorClass;
  readonly dims: Dims;
  readonly tags: string[];
  readonly blueprintId: string;
  readonly size?: string;
}

interface CarlaObjectCatalogResponse {
  readonly carlaVersion: string;
  readonly objects: CarlaObjectDto[];
}

const PROP_TAG_SET = new Set<string>(PROP_TAGS);
const CLASS_TINTS: Readonly<Record<PropClass, string>> = {
  vehicle: "#68a5ff",
  pedestrian: "#f2b35f",
  sidewalk_robot: "#73d5ff",
  robot: "#73d5ff",
  drone: "#9ea7ff",
  animal: "#d7ae76",
  construction: "#ff9250",
  street: "#72c4ae",
  occluder: "#a68de7",
  hazard: "#e06767",
};

let catalogRequest: Promise<CarlaObjectCatalogResponse> | null = null;
const objectsById = new Map<string, CarlaObjectDto>();

/** Fetch and synchronously register every measured CARLA object in this window. */
export async function registerCarlaObjects(): Promise<readonly CarlaObjectDto[]> {
  const catalog = await loadCatalog();
  for (const dto of catalog.objects) registerDto(dto);
  return catalog.objects;
}

/** Resolve one CARLA catalog id, registering its proxy before returning it. */
export async function carlaObjectById(catalogId: string): Promise<CarlaObjectDto | undefined> {
  if (!isCarlaCatalogId(catalogId)) return undefined;
  const cached = objectsById.get(catalogId);
  if (cached) {
    registerDto(cached);
    return cached;
  }
  await registerCarlaObjects();
  return objectsById.get(catalogId);
}

/** Register CARLA references before a scenario document reaches editor-core. */
export async function primeCarlaObjectsForDocument(template: ScenarioTemplateV2): Promise<string[]> {
  const ids = collectCarlaCatalogIds(template);
  if (!ids.length) return [];
  await registerCarlaObjects();
  return ids.filter((id) => !objectsById.has(id));
}

function loadCatalog(): Promise<CarlaObjectCatalogResponse> {
  catalogRequest ??= fetch("/api/carla-objects").then(async (response) => {
    if (!response.ok) throw new Error(`Could not load CARLA objects (${response.status}).`);
    const catalog = (await response.json()) as CarlaObjectCatalogResponse;
    for (const dto of catalog.objects) objectsById.set(dto.catalogId, dto);
    return catalog;
  });
  return catalogRequest;
}

function registerDto(dto: CarlaObjectDto): void {
  const entry: ExternalCatalogEntry = {
    id: dto.catalogId,
    label: dto.label,
    class: dto.class,
    actorClass: dto.actorClass,
    description: `${dto.label} (${dto.blueprintId}), measured from CARLA 0.10.0.`,
    dims: dto.dims,
    tags: dto.tags.filter((tag): tag is PropTag => PROP_TAG_SET.has(tag)),
    defaultParams: {},
    model: carlaModelForBlueprint(dto.blueprintId) ?? { kind: "proxy", tint: CLASS_TINTS[dto.class] },
  };
  registerExternalCatalogEntry(entry);
}

/**
 * Generated CARLA inventory blueprints are intentionally more specific than
 * the bundled model ids. This checked table keeps the blueprint identity in
 * the editor while reusing the exact native GLB/node contracts.
 */
const VEHICLE_MODEL_BY_BLUEPRINT: Readonly<Record<string, keyof typeof CARLA_VEHICLE_MODELS>> = {
  "vehicle.ambulance.ford": "vehicle.ambulance",
  "vehicle.carlacola.actors": "vehicle.box_truck",
  "vehicle.dodge.charger": "vehicle.honda_civic",
  "vehicle.dodgecop.charger": "vehicle.police_cruiser",
  "vehicle.firetruck.actors": "vehicle.fire_engine",
  "vehicle.fuso.mitsubishi": "vehicle.bus",
  "vehicle.gazelle.omafiets": "vehicle.bicycle",
  "vehicle.harley.lowrider": "vehicle.motorcycle",
  "vehicle.kia.carnival": "vehicle.kia.carnival",
  "vehicle.lincoln.mkz": "vehicle.sedan",
  "vehicle.mini.cooper": "vehicle.hatchback",
  "vehicle.nissan.patrol": "vehicle.suv",
  "vehicle.sprinter.mercedes": "vehicle.van",
  "vehicle.taxi.ford": "vehicle.taxi",
  "vehicle.ue4.audi.tt": "vehicle.chevrolet_corvette",
  "vehicle.ue4.bmw.grantourer": "vehicle.minivan",
  "vehicle.ue4.chevrolet.impala": "vehicle.toyota_camry",
  "vehicle.ue4.ford.crown": "vehicle.taxi",
  "vehicle.ue4.ford.mustang": "vehicle.ford_mustang",
  "vehicle.ue4.mercedes.ccc": "vehicle.delivery_van",
  "vehicle.diamondback.century": "vehicle.bicycle",
  "vehicle.bh.crossbike": "vehicle.bicycle",
  "vehicle.yamaha.yzf": "vehicle.motorcycle",
  "vehicle.vespa.zx125": "vehicle.motorcycle",
  "vehicle.kawasaki.ninja": "vehicle.motorcycle",
};

function carlaModelForBlueprint(blueprintId: string): ExternalCatalogEntry["model"] | undefined {
  if (blueprintId in CARLA_PEDESTRIAN_MODELS) {
    return CARLA_PEDESTRIAN_MODELS[blueprintId as keyof typeof CARLA_PEDESTRIAN_MODELS];
  }
  const vehicleId = VEHICLE_MODEL_BY_BLUEPRINT[blueprintId];
  return vehicleId ? CARLA_VEHICLE_MODELS[vehicleId] : undefined;
}

function collectCarlaCatalogIds(value: unknown): string[] {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "catalogId" && isCarlaCatalogId(child)) ids.add(child);
      else visit(child);
    }
  };
  visit(value);
  return [...ids];
}

function isCarlaCatalogId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("carla.");
}
