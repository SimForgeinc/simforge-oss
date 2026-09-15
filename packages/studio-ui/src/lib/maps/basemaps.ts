/**
 * The product's basemap: black and white, in the app's own plate colours.
 *
 * Every 2D map in Studio (scenario coverage, the Maps app, the add-map preview,
 * generated thumbnails) draws on the same monochrome ground so a map reads as
 * *chrome* rather than as a picture, and so the one saturated colour on screen
 * is the brand accent carrying product meaning — coverage, selection, a route.
 * CARTO's own palettes (Voyager's greens and ochres, dark-matter's blue-grey
 * water) competed with that.
 *
 * The recolour is applied to the fetched style rather than shipped as a
 * hand-written style: CARTO keeps the sources, sprite, glyphs and the whole
 * OpenMapTiles layer taxonomy current, and this only restates the colours.
 */

/** Available basemap style definitions for MapLibre GL. */
export const BASEMAPS = [
  {
    id: "dark",
    label: "Dark",
    url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  },
  {
    id: "light",
    label: "Light",
    url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  },
] as const;

/** Union of valid basemap identifiers. */
export type BasemapId = (typeof BASEMAPS)[number]["id"];

/** Default basemap shown on initial map render. */
export const DEFAULT_BASEMAP: BasemapId = "dark";

/** The subset of a MapLibre style layer this module reads and recolours. */
export type BasemapStyleLayer = {
  id?: string;
  source?: string;
  type?: string;
  "source-layer"?: string;
  paint?: Record<string, unknown>;
};

/** The subset of a MapLibre style document Studio passes around. */
export type BasemapStyle = {
  version: number;
  name?: string;
  sources: Record<string, unknown>;
  layers: BasemapStyleLayer[];
  glyphs?: string;
  sprite?: string;
  metadata?: Record<string, unknown>;
};

/**
 * One rung per thing a basemap can draw, keyed to the app's fixed plate tokens
 * (`colors.panelSolid`/`panel`/`panel2` and the white/black hairline scales in
 * `stylex/tokens.stylex.ts`). Literal values, not `var(--…)`: MapLibre paints
 * on a WebGL canvas and never resolves CSS custom properties.
 *
 * Both ramps are neutral greys — no hue anywhere — so the accent is the only
 * chroma on the surface.
 */
type MonochromeRamp = {
  background: string;
  land: string;
  water: string;
  building: string;
  boundary: string;
  roadCasing: string;
  road: string;
  rail: string;
  label: string;
  labelMuted: string;
  labelHalo: string;
};

/** The editor's fixed plate, rung for rung. */
const DARK_RAMP: MonochromeRamp = {
  background: "#0a0a0a", // colors.panelSolid
  land: "#111113", // colors.panel
  water: "#18181b", // colors.panel2
  building: "#1f1f23", // one rung above colors.panel2: buildings must lift off the ground
  boundary: "rgba(255, 255, 255, 0.14)", // colors.lineStrong
  roadCasing: "rgba(255, 255, 255, 0.08)", // colors.line
  road: "rgba(255, 255, 255, 0.15)", // colors.chipStrong
  rail: "rgba(255, 255, 255, 0.1)", // colors.chip
  label: "#ffffff", // colors.textOnPlate
  labelMuted: "rgba(255, 255, 255, 0.5)", // colors.textSubtle
  labelHalo: "#0a0a0a", // colors.panelSolid
};

/**
 * The same scale inverted: the hairline/chip alphas laid in black over paper,
 * so a light basemap has exactly the dark one's structure and just as little
 * hue. Ink is `colors.accentText`, the app's one fixed dark ink.
 */
const LIGHT_RAMP: MonochromeRamp = {
  background: "#f7f7f7",
  land: "#f0f0f0",
  water: "#e6e6e6",
  building: "#dcdcdc",
  boundary: "rgba(10, 10, 10, 0.16)",
  roadCasing: "rgba(10, 10, 10, 0.08)",
  road: "rgba(10, 10, 10, 0.2)",
  rail: "rgba(10, 10, 10, 0.12)",
  label: "#0a0a0a", // colors.accentText
  labelMuted: "rgba(10, 10, 10, 0.55)",
  labelHalo: "#f7f7f7",
};

/**
 * The grey ramp each basemap paints with. Exported because map overlays — the
 * coverage polygons and their labels — have to read against the same ramp, and
 * WebGL paint cannot reach the style tokens they mirror.
 */
export const MONOCHROME_RAMPS: Record<BasemapId, MonochromeRamp> = {
  dark: DARK_RAMP,
  light: LIGHT_RAMP,
};

/** The brand accent, as a WebGL paint literal. Mirrors `colors.accent`. */
export const MAP_ACCENT = "#E8E044";

/**
 * Which rung a style layer paints with, from the OpenMapTiles source layer it
 * reads plus its own id. Source layer first: it is the schema's own
 * classification and is stable across CARTO's style revisions, where layer ids
 * are not.
 */
function rungFor(sourceLayer: string, id: string, ramp: MonochromeRamp): string {
  if (!sourceLayer) return id === "background" ? ramp.background : ramp.land;
  if (sourceLayer === "water" || sourceLayer === "waterway") return ramp.water;
  if (sourceLayer === "building") return ramp.building;
  if (sourceLayer === "boundary") return ramp.boundary;
  if (sourceLayer === "landcover" || sourceLayer === "landuse" || sourceLayer === "park") {
    return ramp.land;
  }
  if (sourceLayer === "transportation") {
    if (id.includes("rail")) return ramp.rail;
    // A casing is the wider line drawn under the fill; CARTO names it so.
    return id.includes("case") || id.includes("casing") ? ramp.roadCasing : ramp.road;
  }
  if (sourceLayer === "aeroway") return ramp.road;
  return ramp.land;
}

/**
 * Restate every colour in a fetched basemap style on the app's grey ramp.
 *
 * Paint properties are replaced outright rather than merged: CARTO expresses
 * several of them as zoom interpolations whose stops carry the colour, and a
 * flat value is both correct and cheaper than rewriting every stop. Layout,
 * filters, zoom ranges, sources, sprite and glyphs are untouched — this is a
 * recolour, not a restyle. Raster layers are left alone: the only raster a
 * Studio map carries is satellite imagery, which is photography.
 */
export function monochromeBasemapStyle(style: BasemapStyle, basemapId: BasemapId): BasemapStyle {
  const ramp = MONOCHROME_RAMPS[basemapId];

  return {
    ...style,
    layers: style.layers.map((layer) => {
      const id = (layer.id ?? "").toLowerCase();
      const sourceLayer = (layer["source-layer"] ?? "").toLowerCase();
      const paint = { ...(layer.paint ?? {}) };

      switch (layer.type) {
        case "background":
          paint["background-color"] = ramp.background;
          delete paint["background-pattern"];
          break;
        case "fill":
          paint["fill-color"] = rungFor(sourceLayer, id, ramp);
          if ("fill-outline-color" in paint) paint["fill-outline-color"] = ramp.boundary;
          delete paint["fill-pattern"];
          break;
        case "line":
          paint["line-color"] = rungFor(sourceLayer, id, ramp);
          delete paint["line-pattern"];
          break;
        case "fill-extrusion":
          paint["fill-extrusion-color"] = ramp.building;
          delete paint["fill-extrusion-pattern"];
          break;
        case "symbol":
        case "circle": {
          // Labels carry two rungs: place and water names read, the rest recede.
          const ink =
            sourceLayer === "place" || sourceLayer === "water_name" ? ramp.label : ramp.labelMuted;
          if (layer.type === "circle") {
            paint["circle-color"] = ink;
            paint["circle-stroke-color"] = ramp.labelHalo;
            break;
          }
          paint["text-color"] = ink;
          paint["text-halo-color"] = ramp.labelHalo;
          // Sprite icons are the one place a hue could survive a recolour.
          paint["icon-color"] = ink;
          paint["icon-halo-color"] = ramp.labelHalo;
          break;
        }
        default:
          // raster/heatmap/hillshade: CARTO's vector styles carry none, and a
          // future one would be imagery, which must not be recoloured.
          break;
      }

      return { ...layer, paint };
    }),
  };
}

/**
 * A valid style in the app's plate colour and nothing else.
 *
 * Every surface mounts on this and swaps to the real ground when the fetch
 * lands: a map has to be handed *some* style synchronously, and a CARTO URL
 * would flash the colourful original for as long as the fetch takes.
 */
export const PLATE_BASEMAP_STYLE: BasemapStyle = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": DARK_RAMP.background },
    },
  ],
};

const MONOCHROME_STYLE_CACHE = new Map<BasemapId, Promise<BasemapStyle>>();

/**
 * Fetch a basemap style and recolour it, once per basemap per page.
 *
 * The promise is cached rather than the resolved style so concurrent mounts
 * share one request; the cached document is never mutated, so callers that
 * filter or drape layers on top can copy it freely.
 */
export function fetchMonochromeBasemapStyle(basemapId: BasemapId): Promise<BasemapStyle> {
  const existing = MONOCHROME_STYLE_CACHE.get(basemapId);
  if (existing) return existing;

  const basemap = BASEMAPS.find((entry) => entry.id === basemapId);
  if (!basemap) {
    throw new Error(`Unknown basemap: ${basemapId}`);
  }

  const promise = fetch(basemap.url, { cache: "force-cache" }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to fetch basemap style: ${response.status} ${response.statusText}`);
    }
    return monochromeBasemapStyle((await response.json()) as BasemapStyle, basemapId);
  });

  MONOCHROME_STYLE_CACHE.set(basemapId, promise);
  return promise;
}
