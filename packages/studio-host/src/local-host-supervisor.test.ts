import { describe, expect, it } from "vitest";
import { serverShutdownEnv } from "./node/local-host-supervisor";

describe("serverShutdownEnv", () => {
  it("lets the Studio server handle SIGTERM itself and gives next dev time to close PGlite", () => {
    expect(serverShutdownEnv({})).toEqual({ NEXT_MANUAL_SIG_HANDLE: "1", NEXT_EXIT_TIMEOUT_MS: "60000" });
  });

  it("keeps an operator's explicit values", () => {
    expect(serverShutdownEnv({ NEXT_MANUAL_SIG_HANDLE: "", NEXT_EXIT_TIMEOUT_MS: "5000" }))
      .toEqual({ NEXT_MANUAL_SIG_HANDLE: "", NEXT_EXIT_TIMEOUT_MS: "5000" });
  });
});
