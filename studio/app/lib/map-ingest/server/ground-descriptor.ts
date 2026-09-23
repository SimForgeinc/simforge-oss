/**
 * `descriptor.ground` of a map version: the ground derivative's ingest
 * validation (derived/ground/ground-manifest.json) recorded next to the mesh
 * member it describes, read back by listScenarioMapDescriptors. Pure; the
 * publication supplies the manifest text and the published mesh digest.
 */
export type GroundDescriptor = { sha256: string; status: "ok" | "flagged" | "no-xodr"; flags: string[]; warnings: string[] };

export function groundDescriptor(manifestText: string, meshSha256: string): GroundDescriptor {
  const manifest = JSON.parse(manifestText) as { status?: unknown; flags?: unknown; warnings?: unknown; mesh?: { sha256?: unknown } };
  if (manifest.mesh?.sha256 !== meshSha256) throw new Error("ground_derivative_mismatch: ground-manifest.json names a different ground-mesh.bin");
  const status = manifest.status;
  if (status !== "ok" && status !== "flagged" && status !== "no-xodr") throw new Error(`ground_derivative_status: unknown ground status ${String(status)}`);
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  return { sha256: meshSha256, status, flags: strings(manifest.flags), warnings: strings(manifest.warnings) };
}
