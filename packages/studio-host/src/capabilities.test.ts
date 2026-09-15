import { expect, it } from "vitest";
import { STUDIO_HOST_PROTOCOL_VERSION, checkHostProtocolVersion } from "./capabilities";

it("accepts a host that speaks exactly this client's protocol version", () => {
  expect(checkHostProtocolVersion({ protocolVersion: STUDIO_HOST_PROTOCOL_VERSION }))
    .toEqual({ ok: true, protocolVersion: STUDIO_HOST_PROTOCOL_VERSION });
});

it("refuses an older host and says the host is the side to upgrade", () => {
  const result = checkHostProtocolVersion({ protocolVersion: 1 }, 2);
  expect(result).toMatchObject({ ok: false, olderSide: "host" });
  expect(result.ok ? "" : result.reason).toMatch(/protocol 1.*protocol 2.*upgrade the host/);
});

it("refuses a newer host and says this client is the side to upgrade", () => {
  const result = checkHostProtocolVersion({ protocolVersion: 2 }, 1);
  expect(result).toMatchObject({ ok: false, olderSide: "client" });
  expect(result.ok ? "" : result.reason).toMatch(/protocol 2.*protocol 1.*upgrade the client/);
});

it("refuses a host that predates versioning instead of treating silence as agreement", () => {
  const legacy = { schema: "simforge.studio-host-capabilities/v1", host: { kind: "local", version: "0.1.0" } };
  expect(checkHostProtocolVersion(legacy)).toMatchObject({ ok: false, olderSide: "host" });
  expect(checkHostProtocolVersion(null)).toMatchObject({ ok: false, olderSide: "host" });
});

it("refuses a protocol version that is not an integer", () => {
  expect(checkHostProtocolVersion({ protocolVersion: "1" })).toMatchObject({ ok: false, olderSide: "host" });
  expect(checkHostProtocolVersion({ protocolVersion: 1.5 })).toMatchObject({ ok: false, olderSide: "host" });
});
