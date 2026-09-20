# Which copy of zod a package gets, and when that matters

Studio composes schemas that other packages define. `@simforge-oss/scenario`
exports the actor draft contracts; the app puts them inside its own
`z.discriminatedUnion`. That only works when both sides are the **same physical
copy of zod** — not the same version, the same directory on disk.

This is a packaging rule, not a style rule, and it is the reason the imports in
this repository look inconsistent.

## The two APIs, and why only one of them is fragile

zod ships two APIs. The classic one (zod 3, `zod`) and zod 4 (`zod`, in the 4.x
line). Composition behaves differently across copies:

| | two copies composed |
| --- | --- |
| classic (3.25.76) | **throws** — `z.discriminatedUnion` reads the option's discriminator through `instanceof`, and a foreign `ZodObject` is not an instance |
| zod 4 (4.4.3) | works — schemas are symbol-branded, so a foreign schema is still recognised |

Measured, not assumed: composing a schema from one installed copy into another
copy's `z.object` parses cleanly on 4.4.3, and the same composition on the
classic API fails with `A discriminator value for key 'k' could not be
extracted from all schema options`.

So the rule is narrow:

> **Every package whose classic-API schemas Studio composes must resolve `zod`
> to the same copy Studio resolves.** Packages that only use zod 4 may each
> have their own copy.

## What that means for dependencies

`npm` materialises an aliased dependency (`"zod-v3": "npm:zod@3.25.76"`) as a
second physical directory even when an identical `zod` is already installed —
verified with a scratch install: `node_modules/zod` and `node_modules/zod-v3`
are two directories and `require('zod').ZodType !== require('zod-v3').ZodType`.
pnpm links both names to one store entry, which is why this never broke in this
repository and broke immediately in an npm-installed host.

Therefore the alias is on the API that tolerates duplication:

- `@simforge-oss/maps` and `@simforge-oss/scenario` depend on **`zod`** for
  their classic-API contracts. Plain name, so an installer dedupes them with
  the consuming app's `zod`.
- `@simforge-oss/scenario` additionally depends on **`zod-v4`**
  (`npm:zod@4.4.3`) for the scenario schema itself, and imports it under that
  name. A duplicate copy of zod 4 is harmless.
- Packages that use only zod 4 — `compiler`, `engine`, `evaluation`, `render`,
  `asset-catalog`, `asset-packer`, `render-worker` — keep a plain
  `"zod": "^4.4.3"` and import `zod`.

A package that needs both APIs has to alias one of them: `package.json` has one
entry per name. Aliasing the fragile one was the bug.

## What is still not ideal

**The zod 4 copies are not deduplicated in an npm host.** An npm install of the
hosted app currently resolves `^4.4.3` to five different 4.x versions across
`@simforge-oss/*`, one nested copy each. That is tolerable only because of the
table above. It also means the JSON Schemas a host generates come from whatever
4.x it happened to install.

**The end state is one zod for the whole stack.** That is either:

1. *Everything on zod 4.* Classic consumers — the app (106 files), `studio-ui`,
   `model-store`, `maps`, and `scenario`'s studio contracts — import
   `zod/v3`, the classic API vendored inside the zod 4 package, and every
   `package.json` pins one 4.x. This keeps zod 4 current. It is a breaking
   change for anyone embedding these packages, and any host with a dependency
   that wants classic zod at the root (an auth library, say) has to move with
   it.
2. *Everything on zod 3.25.76*, with zod 4 users importing `zod/v4`. Rejected
   on evidence: `zod/v4` inside 3.25.76 is the 4.0 release. It is missing 31
   exports 4.4.3 has, and `z.toJSONSchema` emits `anyOf` where 4.4.3 emits
   `oneOf`, which rewrites 6,500 lines of the committed JSON Schemas — a
   published contract — to say something weaker.

Option 1 is the right end state and wants its own change, coordinated with the
hosts, not folded into a packaging fix.
