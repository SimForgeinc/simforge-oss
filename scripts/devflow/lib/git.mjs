// What changed relative to the branch's base: committed work since the merge
// base, plus staged, unstaged and untracked files in the working tree.
import { trySh, sh } from "./util.mjs";

/**
 * Picks the candidate ref whose merge base with HEAD is closest to HEAD.
 * (Local `main`/`dev` can be far ahead of `origin/*` on a dev box, and the
 * closest base is the one that describes "my change".)
 */
export function resolveBase(root, candidates) {
  let best = null;
  for (const ref of candidates) {
    const mergeBase = trySh("git", ["merge-base", "HEAD", ref], { cwd: root });
    if (!mergeBase) continue;
    const distance = Number(trySh("git", ["rev-list", "--count", `${mergeBase}..HEAD`], { cwd: root }) ?? Infinity);
    if (!best || distance < best.distance) best = { ref, sha: mergeBase, distance };
  }
  return best;
}

export function changedFiles(root, baseSha) {
  const lines = (text) => (text ? text.split("\n").filter(Boolean) : []);
  const files = new Set([
    ...lines(sh("git", ["diff", "--name-only", "--no-renames", `${baseSha}`, "HEAD"], { cwd: root })),
    ...lines(sh("git", ["diff", "--name-only", "--no-renames", "HEAD"], { cwd: root })),
    ...lines(sh("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root })),
  ]);
  return [...files].sort();
}
