/**
 * A refused "Export for CLI". Every refusal is loud and names what is
 * missing: a package is either complete or not written at all
 * (docs/engineering/scenario-package.md §8.1 rule 2).
 *
 * `code` is stable (the route answers it as `error`); `status` is the HTTP
 * status the route answers with.
 */
export class ScenarioPackageExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ScenarioPackageExportError";
  }
}
