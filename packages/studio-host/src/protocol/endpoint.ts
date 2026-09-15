import type { Schema } from "./schema";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Query values are stringified by the transport; `null`/`undefined` omit the key. */
export type QueryValue = string | number | boolean | null | undefined;

/**
 * One operation of the host protocol: where it lives, what goes in, what
 * comes back. Declared centrally rather than generated because the route
 * handlers are Next files with no OpenAPI surface to generate from, and the
 * DTOs in `../contracts` are already the hand-maintained source of truth —
 * a generator would add a build step to reproduce what one file states.
 *
 * `Params` are path segments, `Query` the search string, `Body` the JSON
 * request body. The request side is compile-time only: each host validates
 * inbound bodies with its own zod schemas. The response side carries a
 * runtime decoder, because the wire is the one place an untyped value enters
 * the client and a silently wrong field there becomes a UI bug far from its cause.
 */
export type Endpoint<Params, Query, Body, Response> = {
  readonly method: HttpMethod;
  readonly path: Params extends void ? `/${string}` : (params: Params) => `/${string}`;
  readonly response: Schema<Response>;
  /** Phantom carrier so the request types survive inference; never present at runtime. */
  readonly __types: { params: Params; query: Query; body: Body; response: Response };
};

export type AnyEndpoint = Endpoint<any, any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type EndpointParams<E extends AnyEndpoint> = E["__types"]["params"];
export type EndpointQuery<E extends AnyEndpoint> = E["__types"]["query"];
export type EndpointBody<E extends AnyEndpoint> = E["__types"]["body"];
export type EndpointResponse<E extends AnyEndpoint> = E["__types"]["response"];

export function endpoint<
  Params extends Record<string, string> | void = void,
  Query extends Record<string, QueryValue> | void = void,
  Body = void,
  Response = void,
>(definition: {
  method: HttpMethod;
  path: Params extends void ? `/${string}` : (params: Params) => `/${string}`;
  response: Schema<Response>;
}): Endpoint<Params, Query, Body, Response> {
  return definition as Endpoint<Params, Query, Body, Response>;
}

/** The empty body of a `204`, or an endpoint whose body the caller discards. */
export const NO_CONTENT: Schema<void> = { parse: () => undefined };
