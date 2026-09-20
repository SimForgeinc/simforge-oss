import { expect, it } from "vitest";
import {
  STUDIO_HOST_CAPABILITIES_SCHEMA,
  STUDIO_HOST_PROTOCOL_VERSION,
  checkHostProtocolVersion,
  isCloudHost,
  type StudioHostCapabilities,
} from "./capabilities";

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

/** A host report with only the two axes `isCloudHost` reads left meaningful. */
function report(
  host: StudioHostCapabilities["host"],
  persistence: StudioHostCapabilities["persistence"],
): StudioHostCapabilities {
  return {
    schema: STUDIO_HOST_CAPABILITIES_SCHEMA,
    protocolVersion: STUDIO_HOST_PROTOCOL_VERSION,
    transports: ["http"],
    host,
    identity: { mode: "fixed-local", userId: "u", workspaceId: "w", organizationId: null, displayName: null },
    persistence,
    execution: {
      browserSimulation: true,
      renderWorkers: {},
      workerNodes: [],
      nativeRuntime: { state: "unavailable", code: "not_installed", reason: "none", searchedPaths: [] },
    },
    jobs: { families: [], survivesUiClose: false },
  };
}

it("a host is remote when it says so OR when its storage is managed, and local only when neither", () => {
  const local = { kind: "local", label: "SimForge Studio (local)", version: "0.1.0" } as const;
  const cloud = { kind: "cloud", label: "SimCloud", version: null } as const;
  const disk = { kind: "pglite-filesystem", dataRoot: "/home/me/.simforge" } as const;
  const managed = { kind: "managed-postgres-object-storage" } as const;

  expect(isCloudHost(report(local, disk))).toBe(false);
  expect(isCloudHost(report(cloud, managed))).toBe(true);
  // Either axis alone is enough: a host on someone else's machine is not
  // this computer even while it keeps a local database, and managed storage
  // is not this computer's disk even if the host forgot to say "cloud".
  expect(isCloudHost(report(cloud, disk))).toBe(true);
  expect(isCloudHost(report(local, managed))).toBe(true);
});
