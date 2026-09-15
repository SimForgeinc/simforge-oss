/**
 * The two pure functions behind every monogram square in the product: the
 * dataset strip on the scenarios page and the section strip on the evaluation
 * page draw the same affordance and must derive the same letters and the same
 * colour from the same input.
 *
 * They live here rather than beside either strip because the evaluation
 * surface is a bundle boundary (`evaluation/index.ts`): importing them from
 * the dataset strip would pull that whole component — its dropdown menu,
 * tooltip and skeleton — into a portal page that has no datasets.
 */

/** Two letters that stand in for the name: the initials of its first two words, else its first two characters. */
export function datasetMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`;
  return (words[0] ?? "?").slice(0, 2);
}

/**
 * A hue that is a pure function of the id, so a dataset keeps its colour across renders, reloads and
 * reorderings. FNV-1a over the id; the alpha-free HSL keeps every hue readable under white text.
 */
export function datasetHue(datasetId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < datasetId.length; i += 1) {
    hash ^= datasetId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}
