import type { ReactNode } from "react";
import { createHttpStudioHost } from "@simforge-oss/studio-host";
import { StudioHostProvider } from "../../src/host";

/**
 * The same-origin HTTP host every shared screen runs behind in both products.
 * Tests stub `fetch`, so this exercises the real request/response mapping
 * rather than a mocked service object. The host captures its fetch when it is
 * created, so it is handed a thunk that reads the global on every call — the
 * suite's `vi.stubGlobal("fetch", …)` installed after this module loads is
 * what actually answers each request.
 */
export const testStudioHost = createHttpStudioHost({ fetch: (input, init) => globalThis.fetch(input, init) });

export function StudioHostTestProvider({ children }: { children: ReactNode }) {
  return <StudioHostProvider host={testStudioHost}>{children}</StudioHostProvider>;
}
