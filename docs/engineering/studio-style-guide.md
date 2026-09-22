# Studio style guide

How to style anything in Studio so it looks like the rest of Studio. Read this
before writing a `*.stylex.ts` file or passing `xstyle`. The mechanics behind
it (compile roots, package exports, precedence, stacking bands, pointer
events) are in [`studio-stylex-migration.md`](./studio-stylex-migration.md).

## Where to edit

- **OSS owns Studio's styling.** Shared components, tokens and primitives live
  in `packages/studio-ui/src`; app routes and app-only components live in
  `studio/app`.
- **SimCloud's `apps/studio` is generated** from OSS `studio/` plus
  `apps/studio-overlay/`. Never edit it by hand. SimCloud owns only the
  overlay and its marketing pages; everything in this guide applies there too.

## The rules

1. **Every value is a token.** Colour, space, type, stroke, shadow, stacking,
   motion, blur and breakpoints come from
   `packages/studio-ui/src/stylex/tokens.stylex.ts`. The only literals a
   style may hold are `0`, `none`, `auto`, `transparent`, `currentColor`,
   `inherit`, percentages and layout geometry that belongs to one component
   (a grid template, a fixed column width). A missing token is added to the
   token file in the same change, with a comment saying what it is for.
   Never write `#E8E044`, a `rgba(255,255,255,…)`, `150ms`, a
   `cubic-bezier(…)`, a bare `zIndex` or an `@media (min-width…)` string.
2. **Prefer, in this order:** an existing primitive with its props; a new
   variant on that primitive; recipes; then a local layout-only
   `*.stylex.ts`. If two components need the same look, it is a recipe or a
   primitive, not a copy.
3. **A local style module holds layout.** Display, flex/grid, sizing,
   position and the gaps and padding between things (from `space.*`), plus
   one-off artwork. Colour, type, focus, motion, hairlines, z-index and
   breakpoints come from recipes, primitives or tokens.
4. **Compose in one order:** `stylex.props(recipes…, local…, state/variant…,
   xstyle)`. Later wins, so the caller's `xstyle` is always last.
5. **`xstyle` places, it does not reskin.** A caller may move, size and space
   a primitive through `xstyle`; it changes the primitive's look through its
   `variant`, `tone` or `size` props. If no variant fits, add one to the
   primitive rather than restyling it at the callsite.
6. **Name keys by role.** `header`, `row`, `rowActive`, `metaLabel`. Not
   `flexCenterGap2`, `xsMuted2`, `s_742`, and no Tailwind string as the
   comment. A comment says why, not what the declarations are.
7. **State goes through the platform.** `:hover`, `:focus-visible`,
   `[data-state=…]` and `stylex.when.ancestor(":hover")` for a child that
   reacts to its parent. Runtime numbers travel as CSS custom properties on
   `style`, never as a static inline style object.
8. **Studio is square.** A global reset sets every `border-radius` to `0`, so
   never author one. Round things (spinners, status dots) come from their
   primitives.
9. **Motion is quiet.** Colour transitions and fades only, on the shared
   durations and curves, always with a `prefers-reduced-motion` path.
10. **Styles are shared only within a family.** A module is imported by its
    namesake component or by siblings in the same folder family. Anything
    wider is promoted to a recipe or primitive.

## Tokens

`packages/studio-ui/src/stylex/tokens.stylex.ts`. Inside `packages/studio-ui`
import it relatively; from `studio/app` import
`@simforge-oss/studio-ui/stylex/tokens.stylex`.

| Group | What it holds | Reach for |
| --- | --- | --- |
| `colors` | theme bridges (`bg`, `card`, `text`, `mutedForeground`, `border`), the plate (`panel*`), the ladders below, accent, status | the ladder step for the role, never an alpha |
| `text` | faces, sizes, line heights, weights, tracking | a `type` recipe first; these for one-off layout of text |
| `space` | `s0_5` … `s12`, the 0.25rem grid (`s3` = 0.75rem), plus shell widths | every gap, padding and margin |
| `layout` | gutters, measures, breakpoints (`bpSm`, `bpMd`, `bpLg`, `bpXl`, `bp2xl`), `reducedMotion` | computed keys: `{ default: x, [layout.bpSm]: y }` |
| `stroke` | `hairline` (1px), `thick` (2px) | border and rule widths |
| `shadows` | focus rings, the few elevations | the `focus` recipe; elevation only for things that float |
| `layers` | the global stacking bands | every `zIndex` |
| `motion` | durations, curves, blurs | the `motion` recipes first |

The colour ladders, strongest step first:

- **Ink** (text on the dark plate): `ink`, `inkSecondary`, `inkMuted`,
  `inkFaint`, `inkGhost`.
- **Hairlines**: `hairlineSubtle`, `hairline`, `hairlineStrong`.
- **Fills**: `fillFaint`, `fillSubtle`, `fill`, `fillStrong`, `fillStronger`.
- **Scrims** (black, behind modals and over bright frames): `scrimLight`,
  `scrim`, `scrimHeavy`.
- **Accent**: `accent` (text, rules, the primary action), `accentWash` (behind
  the current item), `accentLine`/`accentLineSubtle` (its edge),
  `accentText` (ink on a solid accent).
- **Status**: `positive`, `warning`, `critical`, `info`, each with a `…Wash`.
  Traffic-signal lamp colours (`signal*`) are physical colours, never status.

Names marked `@deprecated` in the token file still compile; do not add new
uses.

## Recipes

`packages/studio-ui/src/stylex/recipes.stylex.ts` (from `studio/app`:
`@simforge-oss/studio-ui/stylex/recipes.stylex`). Each is a few declarations
of look, built only from tokens, composed first in `stylex.props`.

| Recipe | Keys | Use for |
| --- | --- | --- |
| `focus` | `ring`, `ringInset`, `ringAccent`, `ringAccentInset`, `ringOffset`, `outline`, `within` | every focusable element that is not a primitive; exactly one |
| `motionRecipe` | `colors`, `opacity`, `transform`, `spin`, `pulse`, `fadeIn` | every transition or animation; all stop under reduced motion |
| `hairline` | `all`, `top`, `bottom`, `start`, `end`; modifiers `subtle`, `strong`, `hover` | every border and divider |
| `surface` | `plate`, `raised`, `card`, `glass`, `chip`, `scrim` | what a region is made of |
| `interactive` | `base`, `hoverFill`, `hoverInk`, `selected` | clickable rows, tiles and items that are not a `Button` |
| `typography` | `eyebrow`, `meta`, `label`, `body`, `bodySm`, `title`, `heading`, `numeric` | every piece of text: pick the role |
| `control` | `xs`, `sm`, `md`, `lg`, `iconXs` … `iconLg` | the height/padding/size of a custom control, so it lines up with the primitives |
| `a11y` | `srOnly` | text for assistive technology only |
| `textLayout` | `truncate`, `clamp2` | text that must not overflow |

A recipe earns its place by being used in unrelated places. A look that only
one family needs belongs in that family's style module.

## Primitives

Reach for these before writing styles. Their look is set by props; `xstyle`
is typed `PlacementStyle` (or `ControlPlacementStyle` for controls) so a
caller can place one but not reskin it.

| Primitive | Import | Props for the look |
| --- | --- | --- |
| `Button` | `components/ui/button` | `variant`: `accent` (the one primary action), `plate`, `accentOutline`, `quiet`, and the shadcn set; `size`: `xs`, `sm`, `md`, `lg`, `xl`, `icon*` |
| `IconButton` | `components/ui/icon-button` | `label` (required), `variant`: `ghost`, `plate`, `accent`; `size`; `active` |
| `Input` | `components/ui/input` | `size`: `xs`, `sm`, `md`, `lg`; `variant`: `default`, `plate` |
| `Chip`, `ChipButton` | `components/ui/chip` | `tone`, `size`, `leading`; `selected` on the button |
| `Dialog` + parts | `components/ui/dialog` | `DialogContent size`: `sm`, `md`, `lg`, `xl`; `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogBody`, `DialogFooter`, `DialogClose` |
| `Spinner` | `components/ui/spinner` | `size`, `tone`, `label` |
| `Dot` | `components/ui/dot` | `tone`, `size`, `pulse`, `label` |
| `MetaLabel` | `components/stylex` | `tone`, `as` |
| `PageShell` | `components/ui/page-shell` | `title`, `eyebrow`, `description`, `actions`, `fill` |
| `Card`, `Tabs`, `Sheet`, `DropdownMenu`, `Tooltip`, `Switch`, `Table`, `Badge`, `EmptyState`, `Skeleton`, `SelectMenu` | `components/ui/*` | see each file |

`tone` is the shared status axis: `neutral`, `muted`, `accent`, `positive`,
`warning`, `critical`. Add a tone mapping to a primitive rather than passing
a colour.

## The template

Start a component from
[`packages/studio-ui/src/components/template/TemplatePanel.tsx`](../../packages/studio-ui/src/components/template/TemplatePanel.tsx)
and its
[`TemplatePanel.stylex.ts`](../../packages/studio-ui/src/components/template/TemplatePanel.stylex.ts).
It is compiled, typechecked, linted and tested with the package, and shows
every rule above in about a hundred lines: primitives with props, recipes for
the rest, a layout-only style module with no literals, the composition order,
a `PlacementStyle` `xstyle`, a tone lookup, and a child reacting to its row's
hover through a marker.

In `studio/app`, the same shapes apply; import the recipes, tokens and
primitives by their `@simforge-oss/studio-ui/…` subpaths.

## The look

Studio is a dark, square, hairline-ruled instrument. The app switcher is the
reference surface.

- **Ink:** white at a few fixed alphas, never a new grey.
- **Lines:** one hairline weight, low-alpha white; stronger only for hover.
- **Fills:** low-alpha white plates over the near-black background; no drop
  shadows on chrome.
- **Accent:** `#E8E044`, used as signal (the current item, the primary
  action, a focus ring), at most about 5% of any surface.
- **Type:** the body face for content, the meta face uppercase and tracked out
  for labels, counters and status.

## Checks

Both run in CI and must pass before a styling change is finished.

- `pnpm style:ratchet --check` counts raw literals per file against
  `scripts/style/ratchet-baseline.json`. A file may only go down; a new file
  starts at zero. After removing literals, `pnpm style:ratchet --update`
  locks the gain in.
- `pnpm lint:style` runs the StyleX ESLint plugin (unused keys, `defineVars`
  placement) and the guide's syntax bans (radii, literal breakpoints, local
  keyframes, `className` beside `stylex.props`). Errors that predate a ban are
  held in `scripts/style/eslint/eslint-suppressions.json` and may only shrink.

## Changing how something looks

Moving a surface onto the shared system may change its appearance, and that
is expected: the goal is one look, not the pixels a surface happened to have.
Review such a change with before/after screenshots of every surface it
touches. A swap that keeps the rendered value (a literal to the equal token,
an inline copy to the identical recipe) needs no screenshots.
