import {
  EnvironmentSchema,
  type Environment,
  type EnvironmentInput,
} from "../schema/v2/environment.js";

/** Canonical environment applied when authoring a new v2 document. */
export const NEW_DOCUMENT_ENVIRONMENT_DEFAULT: Readonly<Environment> =
  EnvironmentSchema.parse({});

/** Resolve a new document (or partial authored input) using the v2 schema defaults. */
export function resolveNewDocumentEnvironment(
  input: EnvironmentInput = {},
): Environment {
  return EnvironmentSchema.parse(input);
}
