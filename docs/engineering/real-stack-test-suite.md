# The real-stack test suite

Every defect found during the September 15 review passed the unit suite. Not
by accident, and not because the unit tests were bad: each one lived in a
place a unit test structurally cannot look.

- A button built `/dashboard/scenario/<id>/drive`; the page lived at
  `app/dashboard/drive/[documentId]/page.tsx`. Both halves correct, the
  relationship wrong.
- An interactive map was mounted inside a `pointer-events: none` wrapper.
  Visible, correctly sized, dead to input.
- A cleanup commit deleted two `POST` handlers. The callers still compiled,
  the remaining `GET` still worked.
- An upload died in CORS preflight because one store handed the browser
  `http://127.0.0.1:<port>/...` while the page was served from
  `localhost:<port>`.
- A shipped wasm blob reported binding ABI 2 against code requiring ABI 3.
- A sign-in endpoint returned 200 to `curl` and 500 to every real client,
  because Node's `fetch` sends `sec-fetch-mode: cors` with no `Origin`.
- A sandboxed Electron preload threw on `document.documentElement` at top
  level and aborted *before* `contextBridge.exposeInMainWorld`, so
  `window.simforgeDesktop` never existed in any packaged window.

The shape they share: **the failure is at a boundary, and the artifact on
either side of it is individually fine.** A route table and a string. A
component and its wrapper's computed style. A caller and a route module. A
URL builder and the origin the page is served from. A constant and a binary.
A request's headers and a server's policy. A preload script and its sandbox.

That is what this suite covers. It asserts *across* boundaries, in the real
runtime, against the real artifact.

## Running it

```bash
cd e2e
corepack pnpm exec playwright test --project=<project>
```

| Project | Needs | Typical runtime | What it covers |
| --- | --- | --- | --- |
| `defects` | nothing | ~2 s | Source-level boundary guards: route tables, handler exports, runtime ABI |
| `defects-live` | one Studio host | ~4 min | The simulation-preview chain and local-object URL shape, over real HTTP |
| `real-cloud` | network + a cloud environment | ~10 s | Sign-in/sign-out, account creation, tenant scoping against real SimCloud |
| `real-world` | host + browser + GPU | ~10 min | Input reaches interactive surfaces; canvases actually paint |
| `real-render` | the above + a render engine | tens of minutes | Author → render → inspect artifacts |
| `real-corpus` | the above + a migrated corpus | tens of minutes | Scenarios migrated from the production corpus open and compile |

`defects` is the one to run on every change: it needs no server, no network
and no credentials, and it catches three of the seven classes above.

The host-backed projects need a seeded data root, and **will refuse to run
without one**:

```bash
SIMFORGE_E2E_SEED_DATA_ROOT=~/simforge-dev-data \
  corepack pnpm exec playwright test --project=defects-live
```

Two things make this sharper than an ordinary missing-fixture error, and both
cost real debugging time before they were understood:

- **Installation is a database fact, not a disk fact.** Symlinking a corpus
  into an isolated cache leaves `/api/simforge/maps` at `{"maps":[]}` while
  `/api/simforge/maps/catalog` cheerfully lists every entitled map with
  `installed:{browser:false,semantic:false}`. Installing even the smallest
  costs a browser closure of roughly 1.8 GB, so cloning a root that already
  has one is the only affordable fixture.
- **Installation is also a per-profile fact, and a half-installed map is
  ignored *in full*.** A host does not degrade to a browser-only map: the map
  disappears from `/api/simforge/maps` entirely and the host logs `ignored
  incomplete installed map <name>: semantic profile is not installed`. So the
  observable — an empty list — looks nothing like the cause.

Because that cause is never in the spec that fails, the projects check for an
authorable map up front and refuse with a message naming the variable, the
number of entitled maps, and the log line to grep for.

The long projects are separate so the fast ones stay fast. Nothing in
`defects` or `real-cloud` boots a Studio host.

### Credentials and environment

Machine-local configuration is read from `~/.config/simforge/e2e-qa.env`
(owner-only permissions are enforced — the config throws otherwise).
Explicit process environment always wins.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `SIMFORGE_E2E_CLOUD_ORIGIN` | `real-cloud` | The environment under test; defaults to staging |
| `SIMFORGE_E2E_STAGING_ORIGIN` | `real-cloud` | Fallback when the above is unset |
| `SIMFORGE_E2E_SEED_DATA_ROOT` | **required** by `defects-live`, `real-world` | A data root to clone per test, holding at least one *completely* installed map |
| `SIMFORGE_E2E_MAPS_FIXTURE_ROOT` | `real-corpus` | A real installed map corpus (the directory holding `dev-assets/`) |
| `SIMFORGE_E2E_DATA_ROOT` | all host projects | Parent directory for per-test isolated data roots |

**Production is refused, not merely avoided.** `cloudOrigin()` throws on
`simforge.ai`. Read-only intent is not enforceable once a bearer token is in
hand, so the origin is the place to stop it.

## Fixtures

Fixtures are created through the product's own APIs and never by inserting
rows. A hand-made document does not carry the dataset binding, map version
and draft version the chain under test depends on, so a test built on one
passes over a state the product can never produce.

Cloud accounts are **throwaway per run**, created through
`POST /api/desktop/auth/sign-up`, and their sessions are revoked in teardown.
The shared QA identity in `~/.simforge/test-account.env` is read but never
modified and never deleted.

One wrinkle worth knowing before you add a test: **staging throttles sign-up
at roughly six attempts per minute, per IP** (the next returns 429
`{"error":"throttled"}`), and that budget is shared with anything else on the
same address — including a developer probing by hand. `real-cloud` therefore
performs exactly **one** sign-up per run. Every read-only test shares that
account and none mutates it, so they remain order-independent; the sign-out
test opens a *second session* on the same account rather than creating a
second account. That is cheaper, and it is also the stronger assertion,
because it distinguishes session-scoped revocation from account-wide
revocation — something a single-session test cannot see at all.

## What each test catches

### `defects/navigation-targets.spec.ts` — class 1

Reads every App Router page off disk and every navigation target out of
`studio/app`, `packages/studio-ui`, `packages/studio-host` and
`packages/cli`, and asserts each target resolves.

The rule that gives it teeth: **a literal segment in a route pattern is never
satisfied by an interpolation in the target.** `/dashboard/scenario/${id}/drive`
therefore cannot match `dashboard/scenario/[datasetId]` — the trailing literal
`drive` has nothing to sit on — instead of being waved through by a permissive
dynamic match. A second test pins the drive route's resolution *identity*, so
a matcher bug that made everything resolve is still caught.

### `defects/api-handlers.spec.ts` — class 3

Two assertions:

1. **Every route module exports at least one HTTP verb.** A `route.ts` that
   Next.js mounts with nothing to mount is never intentional. This is what
   catches a `complete/route.ts` whose only handler was deleted.
2. **Every request the product makes resolves to a route module exporting
   that verb.** This catches `POST` deleted while `GET` remains.

Getting the second one to actually fire took three corrections, each at the
place the defect lives:

- Generic calls (`request<UploadReservation>(…)`) read as "not a call",
  because walking back from `(` hit `>` and stopped.
- The URL is often a **bound identifier**, not a literal:
  `request(base, { method: "POST" })`. The path never appears at the call
  site at all.
- `base` is declared in several methods of one file, so treating a repeated
  name as ambiguous skipped every one. Resolution is by **nearest preceding
  declaration in the same file** — textual proximity, no cross-file
  inference. An unresolvable name is skipped, never guessed.

Two precision rules keep it from inventing failures, which is the only way a
scan like this survives a real codebase:

- A verb is asserted only when it can be read **exactly**. `hostRequest(path,
  { dataRoot }, { method: "POST" })` puts the verb in a third argument, so
  "an options object with no `method` means GET" is wrong; only `fetch` gets
  that default, because only `fetch` specifies one.
- `` `${CLOUD_ROOT}${path}` `` is a base, not a URL. Those require the
  namespace to exist rather than one exact route.

`KNOWN_DANGLING` records calls whose route genuinely does not exist, each with
the symptom a user sees. It is a baseline, not an exemption list: a separate
assertion fails when an entry **starts** resolving, so a fixed route cannot
leave a stale shield behind.

### `defects/native-runtime-abi.spec.ts` — class 5

Four layers, because the defect can enter at any of them: the shipped wasm
reports the required ABI; the shipped Node addon does too; the Rust constant
and the TypeScript constant agree; and `assertNativeAbi` really refuses a
mismatch. The last one matters most — without it the other three are
documentation, and downgrading the throw to a warning is the tempting change
when a mismatch blocks a release.

The ABI is read from the **instantiated module**, never from a manifest or a
filename. A version recorded beside an artifact is exactly what went stale.

### `defects-live/simulation-preview-chain.spec.ts` — classes 3 and 4

Reserve → upload → complete → read back, on a document created through the
product's own first-run endpoint. Asserts both deleted handlers answer 200
rather than 405, that the stored digest, size and draft version match what
was uploaded, and that reading *before* reserving is genuinely 404 — without
which the final 200 would also pass on a route that always answered 200.

For class 4 it asserts the reserved `uploadUrl` is **same-origin-relative**.
That is where the defect is, and it is checkable without a browser.

### `real/cloud-auth.spec.ts` — class 6

Sign-in driven through the exact shape Node's `fetch` sends. The curl-shaped
and browser-shaped requests are asserted **alongside** it, as controls: when
the platform regresses, the failure shows the original bug's signature — curl
green, real client red — rather than an undiagnosable 500.

Also: a wrong password must be refused with 4xx and explicitly *not* 5xx
("not 200" would have passed while the product was broken for everyone);
sign-out is session-scoped; and tenant scoping answers 200 / 403 / 401 for
own, foreign and absent credentials.

One trap pinned deliberately: the scope header takes a **workspace** id
(`ws_…`), and passing the **organization** id (`org_ws_…`) from the same
payload is refused exactly like a stranger's. A client that conflates them
fails only for real tenants.

### `real/world-interactive-surfaces.spec.ts` — class 2

`document.elementFromPoint` at the centre of the surface. That is the honest
question: `toBeVisible()` says nothing about input, and a Playwright click
"succeeds" as long as *something* takes the event. On failure the helper
names the ancestor that set `pointer-events: none`, so the report says which
element to fix.

Hit-testing proves the event can arrive; a drag that changes the painted
frame proves the map does something with it. Both are needed — a canvas that
receives events with no handlers attached is equally dead, and that is a
different bug with the same symptom.

The readback helper **refuses to sample an unnamed canvas**: it throws if the
named host element holds zero or more than one. This is deliberate. The page
carries a second, decorative WebGL canvas that never changes, and sampling
"the first canvas on the page" produced a false frozen-scene report during
this very investigation. `preserveDrawingBuffer` is forced through an
`addInitScript` wrapper around `HTMLCanvasElement.prototype.getContext`,
installed before the first navigation because the context is taken at mount.

## What it deliberately does not cover

- **Email delivery.** `real-cloud` asserts a password reset can be
  *requested*; there is no mailbox, so verify-by-code and reset-by-code are
  not driven end to end.
- **Account deletion.** `DELETE /api/desktop/account` answers 405 — the
  endpoint does not exist yet. There is no test pretending otherwise.
- **Production.** Refused at the origin.
- **Visual correctness.** The canvas assertions distinguish a painted frame
  from a blank or single-colour one. They do not say the picture is *right*;
  that needs reference images and a perceptual metric.
- **Verb agreement at call sites this scan cannot read exactly** — a spread,
  a computed method, a URL assembled across files. Those still get the
  route-exists assertion, but no verb assertion, because a guess there
  invents failures.
- **Electron preload surfaces.** `window.simforgeDesktop` had never existed
  in a packaged window; the branches guarded by it have never run. A harness
  for that belongs here and is not yet written.

## Adding a test

The bar is one question: **what bug does this fail for?** If you cannot name
it, do not add the test. In particular, do not assert wiring (a field copied,
a default forwarded, a mock echoing its input), and do not assert that
something did not throw.

The tests here each name their defect in a comment, with the symptom a user
saw. That is not decoration — it is what lets the next person decide whether
a failure is a regression or a test that has outlived its bug.
