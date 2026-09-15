import { describe, expect, it } from "vitest";
import { ProtocolDecodeError, ScenarioOperationalJobSchema, STUDIO_HOST_PROTOCOL } from "./index";
import { array, discriminated, literal, nullable, number, object, optional, string, tuple } from "./schema";

const decodeError = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProtocolDecodeError) return error;
    throw error;
  }
  throw new Error("expected a ProtocolDecodeError");
};

describe("protocol decoders", () => {
  it("names the exact field through arrays and nesting", () => {
    const schema = object<{ rows: Array<{ nested: { count: number } }> }>({
      rows: array(object({ nested: object({ count: number() }) })),
    });
    const error = decodeError(() => schema.parse({ rows: [{ nested: { count: 1 } }, { nested: { count: "2" } }] }, "response"));
    expect(error.path).toBe("response.rows[1].nested.count");
    expect(error.message).toBe('response.rows[1].nested.count: expected number, got string "2"');
  });

  it("distinguishes a missing required key from an explicit null and from an optional key", () => {
    const schema = object<{ required: string | null; maybe?: string }>({ required: nullable(string()), maybe: optional(string()) });
    expect(schema.parse({ required: null }, "r")).toEqual({ required: null });
    expect(decodeError(() => schema.parse({ maybe: "x" }, "r")).path).toBe("r.required");
    expect(decodeError(() => schema.parse({ required: "x", maybe: 3 }, "r")).path).toBe("r.maybe");
  });

  it("reports an unknown discriminant value instead of a per-variant failure", () => {
    const schema = discriminated<"mode", { mode: "a"; x: number } | { mode: "b"; y: string }>("mode", {
      a: object({ mode: literal("a"), x: number() }),
      b: object({ mode: literal("b"), y: string() }),
    });
    expect(schema.parse({ mode: "b", y: "ok" }, "r")).toEqual({ mode: "b", y: "ok" });
    const error = decodeError(() => schema.parse({ mode: "c" }, "r"));
    expect(error.path).toBe("r.mode");
    expect(error.expected).toBe('"a" | "b"');
  });

  it("refuses a coordinate pair of the wrong arity", () => {
    const pair = tuple([number(), number()]);
    expect(pair.parse([1, 2], "p")).toEqual([1, 2]);
    expect(decodeError(() => pair.parse([1], "p")).expected).toBe("tuple of 2");
  });

  it("refuses NaN where the contract says number", () => {
    expect(decodeError(() => number().parse(Number.NaN, "n")).message).toMatch(/expected number/);
  });
});

describe("protocol declaration", () => {
  it("covers the four migrated groups and addresses each path under /api/simforge", () => {
    for (const group of ["datasets", "documents", "maps", "jobs"] as const) {
      for (const [name, endpoint] of Object.entries(STUDIO_HOST_PROTOCOL[group])) {
        const path = typeof endpoint.path === "function"
          ? endpoint.path({ datasetId: "d", documentId: "x", tagId: "t", artifactId: "a", jobId: "j", exportId: "e" })
          : endpoint.path;
        expect(path, `${group}.${name}`).toMatch(/^\/api\/simforge\//);
      }
    }
  });

  it("percent-encodes path parameters so an id cannot escape its segment", () => {
    expect(STUDIO_HOST_PROTOCOL.documents.get.path({ documentId: "a/b?c" })).toBe("/api/simforge/documents/a%2Fb%3Fc");
  });
});

describe("operational job ledger", () => {
  const base = {
    id: "job-1", type: "editor_asset_release", status: "succeeded", priority: 0, progress: 1,
    attemptCount: 1, maxAttempts: 1, cancelRequestedAt: null, failureCode: null, failureDetail: null,
    createdAt: "now", updatedAt: "now", startedAt: "now", completedAt: "now",
  };

  /**
   * An `artifact_postprocess` job need not come from a revision: the family
   * also covers work whose subject is not one (an editor asset release, a
   * dataset export, an import that runs before any revision exists). The
   * ledger must be readable for those rows rather than refusing them.
   */
  it("accepts a postprocess job with no revision", () => {
    const row = { ...base, family: "artifact_postprocess", revisionId: null };
    expect(ScenarioOperationalJobSchema.parse(row, "response")).toMatchObject({
      family: "artifact_postprocess",
      revisionId: null,
    });
  });

  /**
   * The other side of that boundary, and the reason this is a union rather than
   * a nullable field: compile/validate/render rows are produced *from* a
   * revision (`revision_id NOT NULL` in all three source tables), so a null
   * there is a host bug and must be named, not absorbed.
   */
  it("refuses a null revision on a family that is always produced from one", () => {
    for (const family of ["openscenario_compile", "openscenario_validate", "openscenario_render"]) {
      const error = decodeError(() =>
        ScenarioOperationalJobSchema.parse({ ...base, family, revisionId: null }, "response"),
      );
      expect(error.path, family).toBe("response.revisionId");
      expect(error.message, family).toMatch(/expected string, got null/);
    }
  });

  it("names the discriminant when the family is one it does not know", () => {
    const error = decodeError(() =>
      ScenarioOperationalJobSchema.parse({ ...base, family: "quantum_bake", revisionId: null }, "response"),
    );
    expect(error.path).toBe("response.family");
    expect(error.expected).toContain("artifact_postprocess");
  });
});
