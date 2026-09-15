/**
 * The Studio host protocol: the wire contract behind `StudioHostServices`.
 *
 * `StudioHostServices` (`../services`) is the semantic API the UI, CLI and
 * worker program against; this module is the wire API it is carried on. Each
 * group declares its endpoints — method, path, request shape, response
 * decoder — in one place, and `createHttpStudioHost` is a transport over these
 * declarations rather than a collection of path strings.
 *
 * The version a host speaks is `STUDIO_HOST_PROTOCOL_VERSION` in
 * `../capabilities`, published by `host/capabilities` and checked by every
 * client before it loads a page. Adding a field to a response is compatible
 * (decoders keep unknown keys); removing or retyping one, or changing a path,
 * is a version bump.
 */
import { STUDIO_HOST_PROTOCOL_VERSION } from "../capabilities";
import { datasetsProtocol } from "./datasets";
import { documentsProtocol } from "./documents";
import { jobsProtocol } from "./jobs";
import { mapsProtocol } from "./maps";
import { runtimeProtocol } from "./runtime";

export const STUDIO_HOST_PROTOCOL = {
  version: STUDIO_HOST_PROTOCOL_VERSION,
  datasets: datasetsProtocol,
  documents: documentsProtocol,
  maps: mapsProtocol,
  jobs: jobsProtocol,
  runtime: runtimeProtocol,
} as const;

export type StudioHostProtocol = typeof STUDIO_HOST_PROTOCOL;

export {
  endpoint,
  NO_CONTENT,
  type AnyEndpoint,
  type Endpoint,
  type EndpointBody,
  type EndpointParams,
  type EndpointQuery,
  type EndpointResponse,
  type HttpMethod,
  type QueryValue,
} from "./endpoint";
export { ProtocolDecodeError, type Infer, type Schema, type Shape } from "./schema";
export * from "./datasets";
export * from "./documents";
export * from "./maps";
export * from "./jobs";
export * from "./runtime";
