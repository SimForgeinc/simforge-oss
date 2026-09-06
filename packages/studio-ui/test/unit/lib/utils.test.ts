import { describe, expect, it } from "vitest";
import { cn } from "../../../src/lib/utils";

describe("cn", () => {
  it("returns a single class unchanged", () => {
    expect(cn("foo")).toBe("foo");
  });

  it("merges multiple classes", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("deduplicates conflicting Tailwind classes, keeping the last one", () => {
    // twMerge resolves conflicts: p-2 and p-4 → p-4
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("filters out falsy values", () => {
    expect(cn("foo", false, undefined, null, "bar")).toBe("foo bar");
  });

  it("supports conditional object syntax from clsx", () => {
    expect(cn({ foo: true, bar: false })).toBe("foo");
  });

  it("supports array inputs", () => {
    expect(cn(["foo", "bar"])).toBe("foo bar");
  });

  it("returns empty string when no truthy inputs provided", () => {
    expect(cn(false, undefined, null)).toBe("");
  });

  it("merges mixed conditional and string inputs", () => {
    const active = true;
    expect(cn("base", active && "active")).toBe("base active");
  });
});
