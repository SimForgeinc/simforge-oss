/**
 * Street-luminaire naming rule, shared by the map pipeline's luminaire
 * derivative (`@simforge-oss/map-pipeline` `luminaires.ts`, what the native
 * renderer lights at night) and the browser viewer's luminaire pool, so both
 * find the same fixtures. Browser-safe: no Node imports.
 *
 * A fixture name carries a street-light token between word boundaries;
 * camel-case boundaries, `_ .-` and braces all separate words (RoadRunner
 * names a fixture `{<guid>}StreetLight_30ft`, Datasmith
 * `a70aaa6bStreetLight_30ft_DefaultSceneRoot`). Generic words such as
 * `light` never classify geometry.
 */
export const LUMINAIRE_NAME = /(?:^|[_ .{}-])(street[_ .-]?lights?|street[_ .-]?lamps?|lamp[_ .-]?posts?|light[_ .-]?poles?|road[_ .-]?lights?|luminaires?)(?:$|[_ .{}-])/i;
/** A lamp head (`Luminaire_Head01`, `{<guid>}Luminaire_Head02`). */
export const LUMINAIRE_HEAD_NAME = /(?:^|[_ .{}-])(?:luminaire|lamp)[_ .-]?head/i;

/** Fixture size gates, metres: a street light's box is this tall and at most this wide. */
export const LUMINAIRE_MIN_HEIGHT_M = 2;
export const LUMINAIRE_MAX_HEIGHT_M = 20;
export const LUMINAIRE_MAX_SPAN_M = 12;
/** Bulb depth under the fixture's top when it has no named lamp head. */
export const LUMINAIRE_BULB_INSET_M = 0.25;
/** A lamp head exported on its own is at most this big. */
export const LUMINAIRE_MAX_STANDALONE_HEAD_SPAN_M = 3;

/** Camel-case boundaries as word separators (`aStreetLight` -> `a Street Light`). */
export const splitCamelBoundaries = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

export const isLuminaireName = (name: string): boolean => LUMINAIRE_NAME.test(splitCamelBoundaries(name));
export const isLuminaireHeadName = (name: string): boolean => LUMINAIRE_HEAD_NAME.test(splitCamelBoundaries(name));
