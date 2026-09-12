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

## Where StyleX lives

| Thing | Path | Import as |
| --- | --- | --- |
| Design tokens | `packages/studio-ui/src/stylex/tokens.stylex.ts` | relative inside the package; `@simforge-oss/studio-ui/stylex/tokens.stylex` from `studio/app` |
| Token barrel | `packages/studio-ui/src/stylex/index.ts` | same objects, same `defineVars` identity |
| Primitives | `packages/studio-ui/src/components/stylex/index.ts` | relative inside the package |
| Primitive vocabulary | `packages/studio-ui/src/components/stylex/surface.ts` | — |
| Component styles | co-located `*.stylex.ts` beside the component | relative |

**Inside `packages/studio-ui`, always import tokens relatively**
(`import { colors, space } from "../../stylex/tokens.stylex"`). Importing the
package by its own name breaks the `development`/`default` export conditions
and can produce two copies of the vars, which silently stops theming.

The `.stylex.ts` suffix is load-bearing, not a naming preference: the Babel
plugin and the PostCSS include globs key off it. Name a component's style
module after the component (`WorkspacePaneLoading.stylex.ts`); name a
family-shared module after the family.

### How the CSS is produced

StyleX compiles ahead of time, so something must transform the
`stylex.create` / `defineVars` calls and collect the output.

- `@stylexjs/babel-plugin` runs from a webpack rule in `studio/next.config.ts`
  and covers `*.stylex.ts` in **both** trees — `packages/studio-ui/src` through
  the `development` export condition, and `dist` in production.
- `@stylexjs/postcss-plugin` collects the generated rules; its include globs
  cover both trees.
- `packages/studio-ui`'s own build (`tsc -p tsconfig.build.json` plus
  `copy-assets`) does **not** transform StyleX. It emits the `defineVars` and
  `create` calls untouched and the app-side transform handles them. The package
  therefore ships no precompiled StyleX CSS, and a consumer outside this app
  would need the same Babel/PostCSS wiring.

`packages/studio-ui/vitest.config.ts` also transforms StyleX modules before
tests import them. Tests must not invoke uncompiled `stylex.create()` or
`defineVars()` at runtime, and must not pin generated class names.

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
conflicts. Tailwind classes are appended last so the cascade resolves them the
way the rest of the app expects.

## Current migration status

The migrated non-protected families currently include:

- shared controls and layout primitives in `packages/studio-ui/src/components/ui`
- Drive HUD, picker, pause, preview, and route shell
- onboarding welcome, map selection, preparation, and gate flows
- asset gallery, upload/generate dialogs, detail drawer, CARLA table, and toolbar
- dashboard host status, cloud storage, settings, model, render, and evaluation surfaces
- evaluation route clients and dataset export panels

Protected map, scenario-editor, and app-switcher surfaces remain appearance-frozen.
The remaining `className` uses in migrated families are explicit composition seams
(for example `PageHeader`, `EmptyState`, `SelectMenuField`, native search controls,
and caller-provided class names), not local styling contracts. New local styling
should use StyleX; retain a bridge only when the shared component or browser API
requires it.

## Protected visual surfaces

Three surfaces are **pixel-preserved**. Their rendered output must not change —
not a colour, not a transition. Do not restyle them and do not migrate them:

1. **The map page** — `studio/app/dashboard/map-assets/**` and
   `studio/app/components/map-assets-map/**`.
2. **The scenario editor** — `packages/studio-ui/src/scenario/editor/**`
   (`regions/`, `inspector/`, `timeline/`, `tutorial/`, `states/`, `shell/`)
   and the routes under `studio/app/dashboard/scenario/`.
3. **The app switcher** — `studio/app/components/AppSwitcherOverlay.tsx`,
   `AppSwitcherArt.tsx`, and the package-side `AppSwitcherSkyScene.tsx` and
   `SkyCloudBackdrop.tsx`.

Non-invasive infrastructure — adding a token, adding a primitive, build wiring,
a package export — may land alongside them. Editing their markup or classes may
not.

These files carry a lot of deliberately tuned, heavily commented visual detail:
the glass scrollbar, the `backwards` animation fill that exists so hover lifts
keep working over the WebGL scene, the `editor-map-dim-non-candidates` dimming,
the dataset→scenario view-transition morph. Those comments are records of fixed
bugs. Treat them as specifications.

Shared components consumed by a protected surface are also appearance-frozen
even when the file itself is in scope. Migrating the implementation is fine;
changing what it looks like is not.

## Overlay invariants

### z-index

Studio has one global stacking order, expressed by the `layers` token group.
The tokens were derived from the literals already in the tree — the scale
renumbers nothing.

| Token | Value | Occupants |
| --- | --- | --- |
| `base`, `raised`, `sticky` | 0, 10, 30 | in-flow chrome, map controls, marker pills |
| `editorChrome` → `editorTop` | 60, 80, 90 | editor resize handles, details panel, popovers, badges, notification dock, editor-local modals |
| `dropdown` | 100 | pickers and menus |
| `tutorial`, `tutorialTop` | 140, 150 | interactive tutorial overlays and guides |
| `dialog`, `dialogTop` | 200, 220 | app dialogs and their scrims; `RenderingBenchmark` at the top of the band |
| `loading`, `loadingTop` | 240, 250 | `CloudLoadingSurface`, `DashboardLoadingCoordinator` |
| `topbar` | 260 | `AppTopBar` |
| `appSwitcher`, `appSwitcherTop` | 300, 310 | app-switcher scrim and content |
| `mapTooltip` | 1000 | map hover readouts and pinned popups |

- **Use a token, never a fresh literal.** A new `z-[95]` invisibly reorders a
  band someone tuned.
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
canvas. The tree is overwhelmingly `pointer-events-none` (≈92 uses against ≈31
`auto`), and that ratio is the invariant, not an accident.

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

1. **Additive only.** Do not delete Tailwind classes, `styles.css` rules,
   Tailwind config entries, or shadcn components in this pass. Migrate a file
   whole or leave it alone.
2. **Pixel parity is the acceptance test.** This is a refactor. If a surface
   looks different afterwards the migration is wrong, even if it looks better.
3. **Don't touch the protected surfaces**, and preserve the appearance of
   shared components that protected surfaces consume.
4. **One owner per file.** The package manifests, compiler config, package
   exports, and CSS injection belong to the foundation change, not to a
   component migration.
5. **Reach for a primitive before writing a `*.stylex.ts`.** If two surfaces
   need the same thing, it is a primitive — but keep primitives small.
6. **Tokens before literals; `tone` before colour; custom properties before
   dynamic styles; relative imports inside the package.**
7. **Keep the comments.** When you move a styled element to StyleX, carry its
   explanatory comment with it. Most of them document a bug that came back.
