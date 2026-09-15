/**
 * Where a Driver in the Loop drive happens.
 *
 * Its own route, because the drive takes the whole screen and owns the viewer
 * while the scenario list keeps the world scene beside it alive. This is the
 * only constructor of that URL — it lives in a leaf module rather than inside
 * `ScenarioDatasetsClient` so the route it names can be checked against the
 * page that actually serves it without pulling in the dataset client's whole
 * component tree.
 */
export function driveHref(documentId: string, roleId: string): string {
  return `/dashboard/drive/${encodeURIComponent(documentId)}?actor=${encodeURIComponent(roleId)}`;
}
