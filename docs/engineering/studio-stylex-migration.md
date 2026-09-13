# Studio styling: the StyleX migration

Studio's styling is migrating from Tailwind to [StyleX](https://stylexjs.com).
The migration is **additive**. Tailwind, the shared stylesheet, and the shadcn
component tree all still ship and still render the product; StyleX is the
target for new and migrated component styling, and nothing is removed until a
surface is fully converted.

This document is the contract between the two systems. Read it before styling
anything in Studio.

## The two trees

Studio UI lives in two places, and which one you are in decides how you import.

| Tree | What it is |
| --- | --- |
| `packages/studio-ui/src` | `@simforge-oss/studio-ui`, the shared component library: the scenario editor, drive, onboarding, evaluation, and `components/ui`. |
| `studio/app` | The Next.js app: routes, API handlers, and app-local components (the top bar, the app switcher, the map-assets views). |

The stylesheet follows the same split. `studio/app/globals.css` is a single
line:

```css
@import "@simforge-oss/studio-ui/styles.css";
```

The real stylesheet — Tailwind directives, the `:root` / `.dark` custom
properties, the glass scrollbar, the sharp-corner reset — is
`packages/studio-ui/src/styles.css`. Edit tokens there, never in `globals.css`.

`@simforge-oss/studio-ui` publishes explicit subpath exports with a
`development` condition pointing at `src` and a default pointing at `dist`.
A new shared module is not importable until its export is added.

### StyleX package exports

A `*.stylex.ts` module shared across the tree boundary gets a subpath export
like any other module — `./components/SkyCloudBackdrop.stylex` and
`./drive/drive.stylex` both exist for that reason — but only a
`stylex.create` module may be *imported* through it. Its class names are
hashed from the file that defines them, so the specifier decides only which
compiled copy is loaded, `src` in development and `dist` in a production
build; `stylexCompileRoots` covers both, and consuming the same copy the
defining component resolves to is what keeps one set of atomic rules instead
of two. `studio/app/components/AppTopBar.stylex.ts` re-exports `cloudPlate`
that way.

**A `defineVars` module is the exception: import it from `src` by path.**
StyleX resolves theme imports itself, with plain Node conditions and no
`development` condition, so a package specifier lands on `dist` — variables
named differently from the `src` copy the dev host loads. That is not
hypothetical: `studio/app/components/AppTopBar.stylex.ts` imports
`@simforge-oss/studio-ui/stylex/tokens.stylex` and emits
`z-index:var(--x1lunseg)`, the name hashed from `dist/stylex/tokens.stylex.js`,
while compiling `src/stylex/tokens.stylex.ts` defines the same token as
`--xil9aes`. It is why `dist` is a compile root: without it the app-side
references have no definition.

The `@simforge-oss/studio-ui/stylex/*` entry in `stylex.config.mjs` does not
change that. StyleX's resolver tries the specifier through Node first and only
falls back to an alias when that throws, so while `dist` exists the alias is
inert; it is what lets the app compile against a package that has never been
built, and nothing more. `studio/app/drive/drive-route.stylex.ts` imports
`driveColors` by relative source path, which is the form that actually pins a
theme to `src`. `./drive/drive.stylex` stays exported for consumers outside
this repo, which have no relative path to use.

## Where StyleX lives

| Thing | Path | Import as |
| --- | --- | --- |
| Design tokens | `packages/studio-ui/src/stylex/tokens.stylex.ts` | relative inside the package; `@simforge-oss/studio-ui/stylex/tokens.stylex` from `studio/app` |
| Token barrel | `packages/studio-ui/src/stylex/index.ts` | same objects, same `defineVars` identity |
| Primitives | `packages/studio-ui/src/components/stylex/index.ts` | relative inside the package |
| Primitive vocabulary | `packages/studio-ui/src/components/stylex/surface.ts` | — |
| Component styles | co-located `*.stylex.ts` beside the component | relative |
| Component styles read from the other tree | co-located `*.stylex.ts` | its own subpath export, e.g. `@simforge-oss/studio-ui/components/SkyCloudBackdrop.stylex` |

**Inside `packages/studio-ui`, always import tokens relatively**
(`import { colors, space } from "../../stylex/tokens.stylex"`). Importing the
package by its own name breaks the `development`/`default` export conditions
and can produce two copies of the vars, which silently stops theming.

The `.stylex.ts` suffix is a naming convention, not a compiler hook. The
webpack rule in `studio/next.config.ts` and the PostCSS include globs both key
off the *compile roots* — `studio/app`, the package's `src`, the package's
`dist` — and match every JS/TS file under them, so StyleX compiles wherever it
is authored: the shared primitives in `src/components/stylex` hold their
`stylex.create` calls inline in the component's own `.tsx`. Keep the suffix
anyway. It is how a reader finds a surface's styles, it is what the `*.stylex`
subpath exports are named from, and a module that exists only to hold styles
should say so. Name a component's style module after the component
(`WorkspacePaneLoading.stylex.ts`); name a family-shared module after the
family.

### How the CSS is produced

StyleX compiles ahead of time, so something must transform the
`stylex.create` / `defineVars` calls and collect the output.

- `@stylexjs/babel-plugin` runs from a webpack rule in `studio/next.config.ts`
  over every `.ts`/`.tsx`/`.js`-family file under the three compile roots in
  `studio/stylex.config.mjs` — `studio/app`, and **both** trees of the
  package: `packages/studio-ui/src` through the `development` export
  condition, and `dist` in production.
- `@stylexjs/postcss-plugin` collects the generated rules; its include globs
  (`app/**`, `src/**`, `dist/**/*.js`) are the glob form of the same roots, so
  the two invocations see exactly one set of files.
- `packages/studio-ui`'s own build (`tsc -p tsconfig.build.json` plus
  `copy-assets`) does **not** transform StyleX. It emits the `defineVars` and
  `create` calls untouched and the app-side transform handles them. The package
  therefore ships no precompiled StyleX CSS, and a consumer outside this app
  would need the same Babel/PostCSS wiring.

`packages/studio-ui/vitest.config.ts` compiles StyleX before tests import it,
and it matches the way the app does rather than by filename: any `.ts`/`.tsx`
file under the package — `src` and `test`, excluding `node_modules` and the
already-compiled `dist` — whose source calls `stylex.create`,
`stylex.defineVars` or `stylex.keyframes`. A primitive or screen that holds
its `create()` inline is therefore importable from a test; matching only
`*.stylex.ts(x)` meant importing `components/stylex` threw `Unexpected
'stylex.create' call at runtime`. Tests must still not invoke uncompiled
`stylex.create()` or `defineVars()` at runtime, and must not pin generated
class names.

The build wiring, the package manifests, the package exports, and the CSS
injection point are owned by one change. Do not edit them from a component
migration.

## Tokens

`tokens.stylex.ts` exports exactly six `stylex.defineVars` groups: `colors`,
`text`, `space`, `radii`, `layers`, `motion`. If a value does not belong in one
of these, it is a component detail and belongs in that component's
`*.stylex.ts`.

Rules:

- **Never hardcode a token's value.** The brand yellow is `colors.accent`, not
  `#E8E044`, everywhere.
- **Tone, not colour.** Primitives take a `tone`
  (`neutral | muted | accent | positive | warning | critical`). Add a tone
  mapping rather than threading a colour through.
- **Signal lamp colours are not semantic tokens.** `signalGreen`,
  `signalYellow`, `signalRed`, `signalOff`, `signalUnknown` are the physical
  colours of a traffic head. They are identical in both themes and must never
  be remapped onto `danger` or `accent`; `styles.css` carries the comment
  explaining which bug that prevents. Note `signalOff` (a commanded dark lamp)
  and `signalUnknown` (no information) are genuinely different states.

### Theming

Theming stays CSS-variable driven. Semantic colours bridge to the custom
properties already in `styles.css` rather than redeclaring values:

```ts
bg: "hsl(var(--background))",
text: "hsl(var(--foreground))",
danger: "hsl(var(--destructive))",
accent: "var(--accent-brand)",
```

`styles.css` keeps the HSL-triplet convention (`--background: 0 0% 4%`,
consumed as `hsl(var(--background))`) and **the `.dark` class remains the theme
switch**. We do not use `stylex.createTheme`. This bridge is what keeps a
migrated StyleX component and its unmigrated Tailwind sibling the same colour
on the same page — which is the whole reason an additive migration is safe.

Colours that are not theme-dependent (the glass alphas, `panel`, `hairline`,
`overlayScrim`) are literal values in the token module.

### Radii: the sharp-corner mandate

`styles.css` ends with a universal reset:

```css
*, *::before, *::after { border-radius: 0 !important; }
```

It is deliberately strong enough to beat Tailwind utilities, arbitrary values,
inline styles, Radix portals, and third-party CSS. Consequently every member of
`radii` is `"0"` except `radii.full` (`9999px`), and **authoring a radius in
StyleX has no effect**. Use `radii.none`; do not try to route around the reset.
The single sanctioned exception is a CSS border spinner, which must stay round
or the spin animation reads as a tumbling square.

### Units: the baseline's unit is the unit

`styles.css` sets `html { font-size: 100% }`, so `rem` tracks the browser's
user-configurable default size and `px` does not. Rewriting one basis as the
other is a visual change that hides on a 16px machine and shows up on every
other one, so the rule is mechanical.

- A value that came from a Tailwind **scale** utility keeps its `rem` basis.
  `p-6` is `1.5rem`, `gap-3` is `0.75rem`, `mt-2` is `0.5rem`, `text-xs` is
  `0.75rem`/`1rem`. Every `space` scale step is therefore `rem` and sits on
  Tailwind's spacing scale (`space.xxs` is `0.125rem`, Tailwind's `0.5`;
  `space.lg` is `0.75rem`, its `3`), as the width tokens in the same group
  already were.
- A value that came from an **arbitrary px** utility stays `px`.
  `text-[11px]` is `11px` at every base size; written as `0.6875rem` it grows
  to `16.5px` on a 24px root.

Mixing the two inside one style object is the worst case: the type scales and
the padding around it does not, so density degrades instead of scaling. It
also puts a migrated surface out of step with the unmigrated Tailwind sibling
beside it on the same page, which is the premise the additive migration rests
on.

### Focus rings: `outline-none` is not `outline: none`

Tailwind's `outline-none` is `outline: 2px solid transparent` with
`outline-offset: 2px` — a *transparent* outline, which suppresses the UA ring
while leaving the control an outline that forced-colours mode can repaint.
`outlineStyle: "none"` erases it instead, and the focus affordance disappears
for high-contrast users. Translate it as the whole set:

```ts
outlineWidth: "2px",
outlineStyle: "solid",
outlineColor: "transparent",
outlineOffset: "2px",
```

Where the baseline scoped it to a state, each longhand carries the same
condition — `outlineStyle: { default: null, ":focus-visible": "solid" }` and
its three siblings, as `asset-gallery.stylex.ts:240-243` writes it.
`asset-grid.stylex.ts`, `AppSwitcherOverlay.stylex.ts`, `AppTopBar.stylex.ts`,
`ActorAppearanceSection.stylex.ts` and `RenderWorkspace.stylex.ts` carry the
same set. The one sanctioned `outlineStyle: "none"` is an element that
deliberately takes no focus ring — `drive-route.stylex.ts`'s canvas — and it
carries a comment saying so.

## Runtime values

StyleX evaluates static `create()` definitions at build time. Runtime values
must use a supported dynamic style or an inline custom property; arbitrary
runtime expressions do not belong in a static style object.

> Static styles come from `stylex.create`. Runtime numbers travel as CSS custom
> properties on the element's inline `style`.

The declared properties are named once in `surface.ts`:

| Variable | Meaning |
| --- | --- |
| `--sfx-progress` | fill fraction, unitless `0`–`1` |
| `--sfx-overlay-inset` | distance a `WorldOverlay` is held off its anchored edges |

Clamp caller-supplied fractions with `clampFraction`. Shared runtime properties
belong in `surface.ts` under the `--sfx-` prefix. Component-local inherited
properties may stay in their owning style module, as the asset card's
hover/focus values do.

Dynamic (function) styles exist in StyleX, but prefer a custom property: it
stays inspectable, overridable, and animatable.

## Primitives

`packages/studio-ui/src/components/stylex/` holds the shared primitives, built
on two axes: `surface` (`"technical"` — flat, hairline-ruled, instrument type;
versus `"expressive"` — glass, blur, soft elevation, product type) and `tone`.

Keep them small. A primitive exists to remove repetition, so a divider or a
label should compile to a couple of rules — a trivial component carrying a
multi-kilobyte variant table is a worse outcome than the markup it replaced.

Every primitive accepts `className`, `style`, and `xstyle`. `xstyle` is the
composition seam: caller styles apply last and win on conflict, matching
`stylex.props()` argument precedence. `className` exists so a primitive
composes with unmigrated Tailwind — a transition affordance, not the preferred
API.

`mergeStyleProps` merges the two. **It deliberately does not run `twMerge`:**
StyleX's atomic class names are opaque to it and would be dropped as phantom
conflicts. Concatenation order is *not* precedence, though: StyleX guards every
atom with three `:not(#\#)` clauses (specificity 0,3,1) and a plain Tailwind
utility is (0,1,0), so for any property the primitive itself declares the
primitive wins no matter where the caller's class sits in the string. A caller
override that contests a declared property must therefore travel as `xstyle`;
`className` is only for what StyleX cannot express — global cascade hooks and
descendant selectors into DOM the primitive does not render.

A caller's own StyleX therefore has to travel as `xstyle`, never as
`className={stylex.props(...).className}`. StyleX only resolves a conflict
between atoms handed to the *same* `props()` call; atoms that arrive on a
primitive as a class string sit beside the primitive's own variant and size
atoms, and the winner becomes stylesheet order — which is the primitive,
because its sheet is emitted later. Baseline `cn()` (`twMerge(clsx(...))`)
made the caller win every such conflict, so routing through `className`
silently inverts precedence. `Switch`, `TooltipContent`, `SheetContent`,
`SheetHeader`, `SheetTitle` and `SheetDescription` carry the seam for this
reason. `className` keeps only strings StyleX cannot express — the
`[&_svg]:*` icon bridge on `Button`, `[&>button:last-child]:hidden` on the
viewport settings sheet — and whatever a caller passes down as its own
public `className`.

The merge is per property *group*, not per condition. A caller that declares
`backgroundColor` at the default condition alone replaces the primitive's
whole `backgroundColor` entry, `:hover` and `[data-state=…]` variants
included. That is what makes a status tone pin its colour through hover the
way the baseline `bg-X/15 hover:bg-X/15` pair did. It also means a caller that
pinned only the rest state in Tailwind — `bg-transparent` on
`Button variant="outline"`, where the variant's `:hover` rule still repainted
the background — has to restate that hover value in its own key, or the state
disappears. Those restatements carry a comment naming the variant they mirror.

`layers` in `tokens.stylex.ts` holds numbers rather than strings for the same
seam: a string token widens to `string`, which the value-checked
`StyleXStyles` type on `xstyle` rejects for `z-index`. The emitted custom
properties are identical either way.

## Current migration status

The migrated non-protected families currently include:

- shared controls and layout primitives in `packages/studio-ui/src/components/ui`
- Drive HUD, picker, pause, preview, and route shell
- onboarding welcome, map selection, preparation, and gate flows
- asset gallery, upload/generate dialogs, detail drawer, CARLA table, and toolbar
- dashboard host status, cloud storage, settings, model, render, and evaluation surfaces
- evaluation route clients and dataset export panels
- the app switcher and the dashboard top bar — `AppSwitcherOverlay`,
  `AppSwitcherArt`, `AppTopBar`, `AppTopBarFrame`, `AppSwitcherSkyScene` and
  `SkyCloudBackdrop` — migrated under the pixel-preserving rule: every literal,
  breakpoint, focus ring, z-index and reduced-motion behaviour carried over
  unchanged. `app-topbar-clouds` and `app-switcher-center-fade` are gone from
  `styles.css`: the cloud plate is `cloudPlate` in
  `SkyCloudBackdrop.stylex.ts`, shared with the top bar's own cloud layer, and
  the dialog's fade is part of `AppSwitcherOverlay.stylex.ts`'s `dialog` style,
  keyed off Radix's `data-state` so the closing frame still animates
- the scenario editor's add-actor panel and render gallery, also under the
  pixel-preserving rule: `actor-add-panel-enter`, `actor-add-panel-resize`,
  `actor-rail-tooltip`, `actor-tool-button`, `actor-panel-close`, `actor-chip`,
  `actor-catalog-chip-enter`, `actor-catalog-tile`, `actor-catalog-tile-icon`,
  `actor-catalog-tile-enter` and `render-tile-enter` are gone from
  `styles.css`. The chip and tile — shared by the catalog rail and the scene
  panels — live in `regions/catalog-surfaces.stylex.ts`; the panel entrance,
  drag edge, tooltip and close button in `regions/ActorLibraryRail.stylex.ts`;
  the gallery tile's entrance in `render/RenderWorkspace.stylex.ts`. Where the
  old CSS reached a child through a descendant selector (a hovered tile's
  glyph, a pressed tool's icon) the parent now publishes a `defineVars`
  transform the child reads, and the per-item entrance delay stays an inline
  runtime value
- the scenario editor's shared transition and its structural spacing
  utilities. `.editor-motion` is gone from `styles.css`: it is
  `motionStyles.editorMotion` in `stylex/motion.stylex.ts`, carrying the same
  property list, `cubic-bezier(0.2, 0.8, 0.2, 1)`, 150ms and the same
  `prefers-reduced-motion` guard, composed through `stylex.props()` at every
  callsite (including `components/ui/select-menu`). The editor's remaining
  `space-y-*` and `divide-y` utilities are gone too. Neither has a StyleX
  form — both are `> * + *` sibling rules, and StyleX only ever styles the
  element it is applied to — so each stack took one of two exact
  replacements: a flex column with the same `gap` where every child is already
  a block-level box with no vertical margin, or the margin/hairline moved onto
  the children with `:first-child` cancelling the first, which is precisely
  what `> :not([hidden]) ~ :not([hidden])` selected. A `<fieldset>` stack must
  use the second form: its rendered legend is not a flex item, so a `gap`
  would drop the space under it. Local components that sit in those stacks
  (`Readout`, `ArtifactRow`, `NumberField`, `ConditionControls`,
  `PointRefControls`) gained an `xstyle` seam for it, and the spacing is
  passed per usage because the same controls also sit in grids that already
  space them

The map page and scenario editor are now StyleX-backed and remain
appearance-frozen. Their rendered output must not change — not a colour, not a
transition. The app switcher and dashboard top bar follow the same rule.

1. **Map page** — `studio/app/dashboard/map-assets/**` and
   `studio/app/components/map-assets-map/**`.
2. **Scenario editor** — `packages/studio-ui/src/scenario/editor/**`
   (`regions/`, `inspector/`, `timeline/`, `tutorial/`, `states/`, `shell/`)
   and the routes under `studio/app/dashboard/scenario/`.
3. **Application chrome** — `AppSwitcherOverlay`, `AppSwitcherArt`,
   `AppTopBar`, `AppTopBarFrame`, `AppSwitcherSkyScene`, and
   `SkyCloudBackdrop`.

The migration is a styling implementation change, not a visual redesign.
What still is not StyleX on those surfaces is listed under
[Residual exceptions](#residual-exceptions), and that list is exhaustive.

These files carry deliberately tuned, heavily commented visual detail:
the glass scrollbar, the `backwards` animation fill that exists so hover lifts
keep working over the WebGL scene, the map dimming, and the
dataset→scenario view-transition morph. Those comments are records of fixed
bugs. Treat them as specifications.

Shared components consumed by these surfaces are also appearance-frozen even
when the implementation is migrated. Changing what they look like is not part
of this work.

### Residual exceptions

Every mechanism below survives on a migrated surface for a stated reason. The
list is the whole of it: a residual that is not one of these is unfinished
work, not a convention, and should be migrated rather than copied.

Note what is *not* on the list. A sibling or child rule (`> * + *`, `> *`) has
no StyleX form either, but it never needs one: the declaration moves onto the
children instead. Both trees answer it the same way — a flex column with the
same `gap` where every child is already a block-level box with no vertical
margin, otherwise the margin moved onto the children with `:first-child`
cancelling the first, which is what the map page's stacks needed wherever a
child is inline-level. `ScenarioEditorShell.module.css`'s `.canvas > *` sizing
went the same way, onto `EditorCanvasRegion`'s own root, when that CSS Module
was retired.

Two more things look like exceptions and are not. A pseudo-class nested inside
a pseudo-element (`"::before": { opacity: { default: 0, ":hover": 1 } }`) is
supported, so `hover:before:*` and `disabled:before:*` have StyleX forms and
are migrated, not bridged — `V1TimelineRail.stylex.ts` and
`ActorLibraryRail.stylex.ts` do exactly that. So are compound state keys such
as `":enabled:hover"` (`V1TimelineRail.stylex.ts:384`,
`TimelineTransportControls.stylex.ts:35`), and attribute conditions:
`"[data-state=active]"` compiles like any other condition, which is how
`tabs.stylex.ts`, `sheet.stylex.ts`, `switch.stylex.ts` and the map page's
`s_742` / `s_748` express Radix state.

A residual class also has to be able to *win*. StyleX guards every atomic rule
with repeated `:not(#\#)`, so a compiled declaration outranks any plain class,
descendant selector or `.dark` ancestor rule that targets the same property. A
Tailwind variant left beside a StyleX rule that declares that property is
therefore not a residual at all — it is dead weight that silently drops the
state. Check the property, not just the mechanism, before leaving one behind.

- **Ancestor state.** `group` with the matching `group-hover:*` utilities
  stays as a Tailwind class *only* where the child's own StyleX rule leaves
  that property undeclared, which is what lets the descendant selector apply.
  A StyleX rule styles only the element it is applied to, so no selector runs
  from a parent's `:hover` down to a child. Eight variants qualify and are the
  whole of it: `group-hover:scale-105` / `group-hover:scale-110` /
  `group-hover:text-primary` in `map-assets.stylex.ts`'s `bridge` (`s_182`,
  `s_183`, `s_188`, `s_549`, `s_554`, under the markers `s_184`, `s_545`,
  `s_552`), `group-hover:scale-[1.04]` in `EditorStatePanels.tsx`, and
  `group-hover:scale-105` / `group-hover:translate-x-1` in
  `RenderingBenchmark.tsx`.
  Everywhere else — and always where the child declares the property — the
  marked ancestor publishes the finished value with `defineVars` and the child
  reads it: the top bar's logo mark, the catalog tile's glyph, the map page's
  `hovered` group, `RenderGalleryTile`'s overlay controls,
  `ActorDetailsPanel`'s driver artwork and `V1TimelineRail`'s split hairline,
  playhead knob and clip handles. A marker whose variants are gone is deleted
  with them; `group/rail` and `group/clip` left the tree that way.
- **State on a component this tree does not own.** The `tailwindcss-animate`
  enter/exit sets — `animate-in` / `animate-out` and their `fade-*` / `zoom-*`
  companions — together with the `data-[state=*]` variants that drive them.
  The animation is a package of custom properties only those variants set, so
  the pair cannot be split. A `data-[state=*]` variant that merely declares a
  value is compiled instead.
- **Descendant selectors into DOM this element does not render.** `[&_svg]:*`
  on `button.tsx`, the `[&_tr]` / `[&:has([role=checkbox])]` compat strings in
  `table.tsx`, and `[&>button:last-child]:hidden` on `ViewportSettingsPanel`'s
  `SheetContent`, which hides the close button `sheet.tsx` renders for itself.
  The declaration belongs to children this element only receives or delegates,
  so it has nowhere self-scoped to go.
- **The theme class.** `.dark` remains the theme switch on `<html>`, but no
  `dark:*` utility survives on a migrated surface: `layout.tsx` fixes `dark`,
  so the dark value is the only one that ever painted and it is folded into
  the rule. A `dark:*` class beside a compiled `color` could not win anyway.
- **`bridge` in `studio/app/dashboard/map-assets/map-assets.stylex.ts`.** The
  map page does not scatter the entries above through its markup: it
  exports one map of surviving Tailwind keyed by the rule each class came
  from, appended at the callsite as
  `stylex.props(styles.s_N).className + " " + bridge.s_N`. Its comment records
  which mechanism each entry is; keep that comment true when you add or remove
  one, and do not use the bridge for anything that has a self-scoped form —
  including the attribute conditions it used to carry.
- **The spinner.** The sharp-corner reset's one sanctioned exception is
  written as `.animate-spin.rounded-full`, so it matches only those literal
  Tailwind classes. A CSS border spinner must keep both.
- **Global classes in `styles.css` still applied by name.** The motion
  utilities, each with its `prefers-reduced-motion` guard: `editor-pulse`,
  `render-view-enter`, `render-surface-motion`, `render-lift`,
  `tutorial-spotlight-ring`, `editor-actor-details-enter` and the three
  `editor-actor-popover-enter-{above,below,right}` variants. Outside the
  frozen trees the same file still carries `scenario-glass-scrollbar`, the
  `list-hero-*` art, the `dataset-aside` view transition and the entrances
  `editor-mode-main-enter`, `route-loading`, `dashboard-scene-loading-enter`
  and `scene-loader-{cloud,content}-{enter,exit}`.
  Two non-motion globals also survive on a single caller each:
  `render-step-center` (`justify-content: safe center`, whose comment records
  the overflow it fixes) and `render-chip` (one background alpha). Those two
  are debt rather than an exception — migrate them when their caller moves.
  A global whose last caller is migrated is deleted in that change, not left
  behind as dead CSS.
- **Renderer-owned selectors.** `editor-map-dim-non-candidates` is a
  descendant rule against DOM MapLibre generates, so nothing in this tree can
  attach a self-scoped class to it.
- **Runtime-derived values.** Geometry and paint that depend on live scene
  data stay explicit, travelling as inline custom properties per
  [Runtime values](#runtime-values) — never as a static `create()` entry.
- **Literal `zIndex` on frozen surfaces.** See the note under
  [z-index](#z-index): the appearance-frozen trees kept their original
  literals verbatim, and that is deliberate.
- **Inline static style maps predating the migration.** Six scenario-editor
  components still hold their appearance in a plain
  `const styles: Record<string, CSSProperties>` handed to `style={…}`, exactly
  as they did before the migration: `CatalogTile.tsx:150`,
  `PanelSearchResults.tsx:126`, `AddWeatherPanel.tsx:487`,
  `ActorLibraryRail.tsx:910`, `AddTrafficPanel.tsx:153` and
  `panel-tiles.tsx:111`, all under
  `packages/studio-ui/src/scenario/editor/regions/`. They are not migrated and
  not a convention — they are the frozen editor tree's remaining debt, listed
  here so the exhaustiveness claim above stays true. Migrate one only with the
  frozen-surface rule in force: the rendered output must not change.

## Overlay invariants

### z-index

Studio has one global stacking order, expressed by the `layers` token group.
The tokens were derived from the literals already in the tree — the scale
renumbers nothing, and a migration that changes a surface's band is a visual
change, not a naming one. It is a scale for the bands that surfaces share, not
a complete census: the migrated frozen surfaces carry their original literals
verbatim wherever no token had that exact value.

| Token | Value | Occupants |
| --- | --- | --- |
| `base`, `raised`, `sticky` | 0, 10, 30 | in-flow chrome, map controls, marker pills |
| `popover` | 50 | the shadcn portals: dropdown menus, tooltips, sheets and the sheet scrim, all written against Tailwind's `z-50` and deliberately *below* the editor chrome |
| `editorChrome` → `editorTop` | 60, 80, 90 | editor resize handles, details panel, popovers, badges, notification dock, editor-local modals |
| `dropdown` | 100 | pickers and menus — `ScenarioMapPickerDialog`, still a `z-[100]` residual |
| `tutorial`, `tutorialTop` | 140, 150 | interactive tutorial overlays and guides |
| `dialog`, `dialogTop` | 200, 220 | app dialogs and their scrims; `RenderingBenchmark` at the top of the band |
| `loading`, `loadingTop` | 240, 250 | `CloudLoadingSurface`, `DashboardLoadingCoordinator` |
| `topbar` | 260 | `AppTopBar` |
| `appSwitcher`, `appSwitcherTop` | 300, 310 | app-switcher scrim and content |
| `mapTooltip` | 1000 | map hover readouts and pinned popups |

- **Use a token, never a fresh literal.** A new `z-[95]` invisibly reorders a
  band someone tuned.
- **Migrated literals are not new literals.** The pixel-preserving rule
  outranks this one, so the frozen trees still hold values the table does not
  name — `70` (notification dock), `81`/`82` (anchored popover, details and
  tools panels), `85` (unanchored badges), `130`/`145` (tutorial overlay and
  guide) and the map's `999`. Carrying one across a migration is correct;
  inventing one is not. If you need a band that has no token, add the token
  rather than the literal.
- **Respect the pairs.** Several surfaces are a scrim plus its content ten
  apart (`300`/`310`, `200`/`210`, `240`/`250`). Move one and the other must
  move with it.
- **The map tooltip ceiling is real.** Map readouts sit at `999`/`1000` because
  they must clear MapLibre's own DOM. Nothing else belongs up there.
- **Mount overlay providers once.** `ScenarioWorkspaceStatusProvider` is mounted
  at `studio/app/dashboard/scenario/layout.tsx` and nowhere below it. A second
  provider does not nest, it *stacks*: two docks at identical coordinates
  reading the same store, every notification painted twice at doubled opacity
  on translucent surfaces. It reads as a styling bug and is a mounting bug.

### Pointer events

Studio's overlays sit on top of a live 3D scene, and input has to reach the
canvas. Inert boxes outnumber interactive ones better than two to one across
the tree, counting `pointerEvents` and `pointer-events-*` together, and that
ratio is the invariant, not an accident.

- **A full-bleed overlay container is `pointer-events: none`; its interactive
  children opt back in with `pointer-events: auto`.**
- `EditorCanvasRegion` is the canonical case: with `externalWorld` set it goes
  `pointer-events-none bg-transparent` so the already-mounted world underneath
  receives input, and re-enables events only on the child wrapper.
- **Decoration is always inert.** Gradient washes, glows, blurred ambience and
  glass backdrops carry both `aria-hidden="true"` and `pointer-events-none`.
- **Never make a full-viewport element interactive just to catch a click.** It
  will eat orbit and drag on the scene beneath it.
- A `pointer-events: auto` element covering the canvas must be genuinely modal,
  and must sit in one of the modal `layers` bands.

## Migration rules

1. **Clean cutover.** Local styling moves from Tailwind utilities and global
   component rules to colocated StyleX. A global class or local bridge whose
   last caller is migrated is deleted in the same change. What may remain is
   exactly the list under [Residual exceptions](#residual-exceptions) — the
   selectors StyleX has no form for, runtime-derived values, and the
   renderer-owned rule — and each survivor carries a comment saying which it
   is.
2. **Pixel parity is the acceptance test.** This is a refactor. If a surface
   looks different afterwards the migration is wrong, even if it looks better.
3. **Preserve protected-surface behavior.** The map, scenario editor, app
   switcher, and top bar are appearance-frozen while their implementation
   moves to StyleX.
4. **One owner per file.** The package manifests, compiler config, package
   exports, and CSS injection belong to the foundation change, not to a
   component migration.
5. **Reach for a primitive before writing a `*.stylex.ts`.** If two surfaces
   need the same thing, it is a primitive — but keep primitives small.
6. **Tokens before literals; `tone` before colour; custom properties before
   dynamic styles; relative imports inside the package; `src` by path for
   `defineVars`, the subpath export for everything else.**
7. **Keep the comments.** When you move a styled element to StyleX, carry its
   explanatory comment with it. Most of them document a bug that came back.
