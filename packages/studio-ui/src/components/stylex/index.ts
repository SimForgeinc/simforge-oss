/**
 * StyleX primitive vocabulary.
 *
 * The primitives themselves live in `../ui` (Button, Input, Dialog,
 * IconButton, Chip, Spinner, Dot, PageShell, …) and the looks they share in
 * `../../stylex/recipes.stylex`. This barrel holds the types every primitive
 * uses for its `tone` and `xstyle`, the `mergeStyleProps` helper, and
 * `MetaLabel`, the instrument label.
 */

export { MetaLabel, type MetaLabelProps, type MetaLabelElement } from "./MetaLabel";
/** Kept here for callers that import it from the vocabulary barrel. */
export { Progress, type ProgressProps, type ProgressSize } from "../ui/progress";
export {
  mergeStyleProps,
  type ControlPlacementStyle,
  type PlacementStyle,
  type Tone,
  type XStyle,
} from "./surface";
