import { describe, expect, it } from "vitest";
import { CloudOrigin, HostOrigin, InvalidOriginError, cloudPath, hostPath } from "./origins";

function received(headers: Record<string, string>, url = "http://localhost:5199/api/simforge/host/session?x=1") {
  return new Request(url, { headers });
}

describe("HostOrigin.fromReceivedRequest", () => {
  it("answers in the caller's authority, not the server's bound interface", () => {
    // A host bound to 0.0.0.0 sees `localhost:5199`; the client reached it
    // over the tailnet and must be handed URLs it can resolve.
    const origin = HostOrigin.fromReceivedRequest(received({ host: "100.64.0.10:5421" }));
    expect(origin.toURL(hostPath("/dashboard")).href).toBe("http://100.64.0.10:5421/dashboard");
    expect(origin.owns("http://100.64.0.10:5421")).toBe(true);
    expect(origin.owns("http://localhost:5199")).toBe(false);
  });

  it("takes the scheme from a TLS terminator and drops the bound port behind a proxied name", () => {
    const origin = HostOrigin.fromReceivedRequest(received({ host: "studio.example", "x-forwarded-proto": "https, http" }));
    expect(origin.toURL(hostPath("/")).href).toBe("https://studio.example/");
    expect(origin.isSecure()).toBe(true);
    expect(origin.hrefForCookie()).toBe("https://studio.example");
  });

  it("falls back to the server's view without a Host header", () => {
    expect(HostOrigin.fromReceivedRequest(new Request("http://localhost:5199/x")).hrefForCookie()).toBe("http://localhost:5199");
  });

  it("rejects a Host that is not an authority", () => {
    for (const host of ["evil.example/path", "user@studio.example", "studio.example:80:80", "a b", ""]) {
      expect(() => HostOrigin.fromReceivedRequest(received({ host })), host).toThrow(InvalidOriginError);
    }
  });
});

describe("HostOrigin.fromConfigured", () => {
  it("accepts an exact origin and canonicalizes it", () => {
    expect(HostOrigin.fromConfigured("HTTP://Studio.Example:5421/", "dev").hrefForCookie()).toBe("http://studio.example:5421");
    expect(HostOrigin.fromConfigured("https://studio.example:443", "packaged").hrefForCookie()).toBe("https://studio.example");
  });

  it.each([
    ["userinfo", "http://user:pw@127.0.0.1:5199"],
    ["path", "http://127.0.0.1:5199/studio"],
    ["query", "http://127.0.0.1:5199/?x=1"],
    ["fragment", "http://127.0.0.1:5199/#top"],
    ["scheme", "ftp://127.0.0.1:5199"],
    ["not a URL", "127.0.0.1:5199"],
  ])("rejects a configured origin with %s", (_label, value) => {
    expect(() => HostOrigin.fromConfigured(value, "dev")).toThrow(expect.objectContaining({ code: "host_origin_invalid" }));
  });

  it("refuses plaintext on a network address in a packaged shell unless acknowledged", () => {
    expect(() => HostOrigin.fromConfigured("http://100.64.0.10:5421", "packaged"))
      .toThrow(expect.objectContaining({ code: "host_origin_plaintext_network" }));
    expect(HostOrigin.fromConfigured("http://100.64.0.10:5421", "packaged", { plaintextNetworkAcknowledged: true }).hrefForCookie())
      .toBe("http://100.64.0.10:5421");
    expect(HostOrigin.fromConfigured("http://127.0.0.1:5421", "packaged").hrefForCookie()).toBe("http://127.0.0.1:5421");
    expect(HostOrigin.fromConfigured("http://100.64.0.10:5421", "dev").hrefForCookie()).toBe("http://100.64.0.10:5421");
  });
});

describe("host paths", () => {
  it("cannot name another authority", () => {
    expect(() => hostPath("//attacker.example/dashboard")).toThrow(InvalidOriginError);
    expect(() => hostPath("/\\attacker.example/dashboard")).toThrow(InvalidOriginError);
    expect(() => hostPath("https://attacker.example/dashboard")).toThrow(InvalidOriginError);
    expect(() => hostPath("dashboard")).toThrow(InvalidOriginError);
  });

  it("relative() canonicalizes on the host and keeps query and fragment", () => {
    const origin = HostOrigin.fromConfigured("http://127.0.0.1:5199", "dev");
    expect(origin.relative(hostPath("/dashboard/../scenario?id=1#frame")).value).toBe("/scenario?id=1#frame");
  });
});

describe("CloudOrigin", () => {
  it("is absent, not production, when nothing is configured", () => {
    expect(CloudOrigin.fromEnvironment({}, "dev")).toBeNull();
    expect(CloudOrigin.fromEnvironment({}, "packaged")).toBeNull();
    expect(CloudOrigin.fromEnvironment({ SIMFORGE_CLOUD_ORIGIN: "  " }, "dev")).toBeNull();
  });

  it("uses the configured origin", () => {
    expect(CloudOrigin.fromEnvironment({ SIMFORGE_CLOUD_ORIGIN: "https://staging.simforge.ai/" }, "packaged")?.toURL(cloudPath("/api/desktop/token")).href)
      .toBe("https://staging.simforge.ai/api/desktop/token");
  });

  it("allows loopback HTTP only in development", () => {
    expect(CloudOrigin.fromConfigured("http://127.0.0.1:4000", "dev").hrefForVault()).toBe("http://127.0.0.1:4000");
    expect(() => CloudOrigin.fromConfigured("http://127.0.0.1:4000", "packaged")).toThrow(expect.objectContaining({ code: "cloud_origin_insecure" }));
    expect(() => CloudOrigin.fromConfigured("http://cloud.example", "dev")).toThrow(expect.objectContaining({ code: "cloud_origin_insecure" }));
  });

  it.each([
    "https://user:pw@simforge.ai",
    "https://simforge.ai/app",
    "https://simforge.ai/?x=1",
    "https://simforge.ai/#x",
    "wss://simforge.ai",
  ])("rejects %s", (value) => {
    expect(() => CloudOrigin.fromConfigured(value, "packaged")).toThrow(expect.objectContaining({ code: "cloud_origin_invalid" }));
  });
});

describe("host and Cloud values do not mix", () => {
  const host = HostOrigin.fromConfigured("http://127.0.0.1:5199", "dev");
  const cloud = CloudOrigin.fromConfigured("https://staging.simforge.ai", "packaged");

  it("at the type level", () => {
    // @ts-expect-error a Cloud path cannot be resolved on the host
    host.toURL(cloudPath("/api/desktop/token"));
    // @ts-expect-error a host path cannot be resolved on the Cloud
    cloud.toURL(hostPath("/api/simforge/host/session"));
    // @ts-expect-error a host origin is not a Cloud origin
    const asCloud: CloudOrigin = host;
    // @ts-expect-error a Cloud origin is not a host origin
    const asHost: HostOrigin = cloud;
    // @ts-expect-error there is no string to pass to a URL constructor
    new URL("/x", host.value);
    expect([asCloud, asHost]).toHaveLength(2);
  });

  it("and each resolves only its own paths", () => {
    expect(host.toURL(hostPath("/a")).href).toBe("http://127.0.0.1:5199/a");
    expect(cloud.toURL(cloudPath("/a")).href).toBe("https://staging.simforge.ai/a");
  });
});
