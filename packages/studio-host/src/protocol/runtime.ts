import type { StudioHostCapabilities } from "../capabilities";
import { endpoint } from "./endpoint";
import { passthrough } from "./schema";

/**
 * The handshake document. Not decoded field-by-field here: it is the one
 * response a client reads *before* it knows which protocol version the host
 * speaks, so its compatibility rule lives with the version constant
 * (`checkHostProtocolVersion` in `../capabilities`), not in a v1 schema.
 */
export const runtimeProtocol = {
  capabilities: endpoint<void, void, void, StudioHostCapabilities>({
    method: "GET",
    path: "/api/simforge/host/capabilities",
    response: passthrough<StudioHostCapabilities>(),
  }),
} as const;
