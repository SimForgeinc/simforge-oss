# W8 arm data: read the error column before the admission column

Written 2026-08-16 00:40 by the supervising thread, after the sweep host was rate-limited and the
supervisor stopped with 29/30 arms complete but uncommitted. The arms are now committed under
`W8-arms/`. This note records a measurement fact, **not** an analysis — the pre-registered analysis
still belongs to the lane. But the fact changes the interpretation enough that reporting raw
admission rates without it would produce two conclusions that are simply false.

## The fact

**100 of 580 brief-attempts (17.2%) never produced an authored artifact at all.** They are recorded
in each arm as `authorErrorCount` and per-row `error`, and they are *not* gate rejections. Two
distinct causes appear:

- `author_call_failed` — the model call itself failed (openai-codex arms)
- `unhandled` — an unhandled exception in the authoring path (Anthropic arms)

Distribution, out of 20 attempts per arm:

| model | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| `gpt-5.6-luna` | 0 | 0 | 0 | 0 | **4** |
| `gpt-5.6-sol` | 0 | 0 | 0 | 0 | 0 |
| `gpt-5.6-terra` | 0 | 0 | 0 | 0 | **20** |
| `claude-opus-5` | **17** | **17** | **9** | **6** | **17** |
| `claude-fable-5` | 3 | 0 | 2 | 3 | 2 |
| `claude-sonnet-5` | 0 | 0 | 0 | 0 | *(pending)* |

## The two false conclusions this prevents

**1. "`gpt-5.6-terra` at max effort scores 0.00 admission."** It scored 0 because **20 of 20 calls
failed**, not because it authored 20 bad scenarios. There is no quality signal in that cell at all.
The same applies to `claude-opus-5` at max (17 of 20 failed).

**2. "`claude-opus-5` improves sharply with reasoning effort" (0.05 → 0.10 → 0.45 → 0.50).** That
curve is almost entirely its *error rate* falling — 17 → 17 → 9 → 6. Among briefs that actually
produced an artifact its rate is 0.33 → 0.67 → 0.82 → 0.71, on usable-n of 3, 3, 11 and 14. Those
denominators are far too small to support any claim, in either direction.

## Admission among briefs that produced an artifact

`admitted / (20 - authorErrorCount)`. Cells with a tiny denominator are marked; they are not
evidence.

| model | low | medium | high | xhigh | max | mean |
|---|---|---|---|---|---|---|
| `gpt-5.6-luna` | 0.65 | 0.70 | 0.65 | 0.60 | 0.56 | 0.633 |
| `gpt-5.6-sol` | **0.75** | 0.70 | **0.75** | 0.65 | 0.65 | **0.700** |
| `gpt-5.6-terra` | 0.70 | 0.65 | 0.70 | 0.60 | — *(0 usable)* | 0.662 |
| `claude-opus-5` | 0.33 †n=3 | 0.67 †n=3 | 0.82 †n=11 | 0.71 †n=14 | — †n=3 | *unusable* |
| `claude-fable-5` | 0.76 †n=17 | 0.65 | 0.67 †n=18 | 0.71 †n=17 | 0.78 †n=18 | 0.713 |
| `claude-sonnet-5` | 0.55 | 0.65 | 0.65 | 0.65 | *(pending)* | 0.625 |

## What this does to the pre-registered hypotheses

Stated as observations for the lane to test properly, not as verdicts:

- **H1 (effort raises admission, monotonically, within model).** Every model with a clean error
  record trends **flat or downward** with effort: luna 0.65 → 0.56, sol 0.75 → 0.65, terra
  0.70 → 0.60. Reasoning tokens rise ~17–30× across that same span. The only apparent rise is
  `claude-opus-5`, and it is confounded by error rate as above. H1 looks falsified, and the failure
  is not marginal.
- **H2 (model rank stable across effort).** Among the three codex models the ordering
  sol > terra > luna holds at low, medium and high. It is worth checking whether the CIs permit
  calling that an ordering at all — at n=20 every interval spans roughly ±0.20 and they overlap
  heavily.
- **Reliability, not quality, is the largest measured difference between models.** `sol` completed
  100 of 100 attempts. `claude-opus-5` failed 66 of 100. That is a much bigger effect than any
  admission-rate gap in the table, and it was not one of the three pre-registered hypotheses.

## The honest caveat on the raw metric

The pre-registration fixed the primary metric as gate admission rate over the 20 briefs — i.e. the
raw numerator/20, which counts an author failure as a non-admission. That definition is defensible
for a production question ("if I run this arm, what fraction of briefs yield an admitted
scenario?") and indefensible for a quality question ("which model authors better?"). **Report both,
label which is which, and do not silently switch between them.** The pre-registration also required
that "refusal/error rate be separated from gate rejection, because collapsing the two would flatter
the weaker arms" — in the event it turned out to flatter nothing and instead to invent a cliff.

## Provenance

- Raw per-arm records: `W8-arms/arm-<model>-<effort>.json`, 29 files.
- The fixed 20-brief sample every arm shared: `W8-arms/sample.json`.
- Missing at the time of writing: `claude-sonnet-5-max`, launched separately since `claude-sonnet-5`
  routes to an account with headroom while Fable is rate-limited.
- Cause of the stop: `michael@simforge.ai` 5-hour window at 100%, every Fable request returning
  HTTP 429 with `retry-after-ms` ≈ 1,791,000. Not a research failure.

---

# UPDATE — sweep complete at 30/30, and all three failure modes are now root-caused

`claude-sonnet-5-max` finished: **1/20 admitted, 19 `author_call_failed`.** All 30 arms are now
committed under `W8-arms/`, every one carrying the same pipeline sha `538200ab824701d0` and the same
20 briefs, so they are mutually comparable.

The 100 author failures are **not one problem**. They are three, with different causes and different
consequences for the analysis.

## 1. `max` effort exhausts the output budget — 43 failures, all at max, zero elsewhere

```
author_call_failed by effort:  low 0 · medium 0 · high 0 · xhigh 0 · max 43
```

Two evidence strings, straight from the arm records:

- `claude-sonnet-5` max — `empty output (status=incomplete, incomplete={'reason': 'max_output_tokens'})`
- `gpt-5.6-luna` / `gpt-5.6-terra` max — `ReadTimeout: timed out`

So at max effort the reasoning consumes the entire `max_tokens=12000` budget before any answer is
emitted, or the call exceeds `vlm.ask`'s 300 s timeout. Both are **harness limits, not model
quality.** For scale: a *trivial* prompt at luna/max was previously measured at 239 s, so a real
authoring prompt exceeding 300 s is expected, not surprising.

Failure rate at max is **62/120 = 51.7%**, against **57/480 = 11.9%** at every other effort — 4.4×.
Combined with H1 being flat-to-downward, `max` effort is not merely useless here, it is actively
harmful. Cost per admitted scenario at max: `claude-fable-5` 0.6 min, `sol` 2.4 min, `luna` 9.2 min,
`claude-sonnet-5` 45.6 min, `terra` and `opus-5` **infinite** (zero admissions for 102.7 and 25.9
minutes of wall time respectively).

## 2. A code bug voids the Anthropic arms entirely — 76 failures, all efforts

```
unhandled by effort:  low 20 · medium 17 · high 11 · xhigh 9 · max 19
concentrated in:      claude-opus-5 (66/100), claude-fable-5 (10/100)
```

Error text: `cannot use 'list' as a dict key (unhashable type: 'list')`.

**Root cause, reproduced deterministically with no model call:** `author_llm.py:110` (and the
equivalent lines in the other compilers) tests

```python
cat = d.get('challengerCatalog') if d.get('challengerCatalog') in VEHICLES else 'vehicle.sedan'
```

`VEHICLES` is a **dict**, so the `in` test hashes the key. The Anthropic models return enum fields
wrapped in a single-element list — `challengerCatalog: ["vehicle.sedan"]` — and hashing a list
raises. Confirmed by calling the compiler directly:

```
scalar catalog   -> OK
LIST catalog     -> TypeError: cannot use 'list' as a dict key (unhashable type: 'list')
```

Note the asymmetry that hid this: `FAMILIES` is a tuple, so a list-valued `family` is rejected
cleanly by `decide()` with a readable error. `VEHICLES` and `VRUS` are dicts, so a list-valued
catalog crashes instead. The numeric fields were already protected — `_scalar()` returns the default
for any `list`/`tuple`/`dict` — but the enum-membership tests were not.

### Consequence, stated plainly

**The `claude-opus-5` and `claude-fable-5` arms are not valid measurements of those models.** Their
usable denominators are 3, 3, 11, 14, 3 and 17, 20, 18, 17, 18. `claude-opus-5` in particular — a
frontier model, and the one the owner's "use the absolute best model" instruction most points at —
was never fairly evaluated. Its apparent effort gradient is its error rate falling, nothing more.

## 3. What must NOT happen next

**Do not silently patch `author_llm.py` and carry on.** All 30 arms record pipeline sha
`538200ab824701d0`; changing the file makes them incomparable with anything run afterwards, and this
project has already been damaged once by a number whose provenance shifted underneath it.

The disciplined route is an **AMENDMENT 2** to the pre-registration, written before the re-run:

1. Fix the enum-membership tests to tolerate a single-element list (or reject it cleanly with a
   readable error, rather than a `TypeError`). Guard `VEHICLES`, `VRUS`, `OCCLUDERS` the way
   `_scalar()` already guards the numeric fields.
2. Raise `vlm.ask`'s timeout and `max_tokens` enough that max-effort calls can complete, or record
   `max` as unsupported by this harness and drop it from the design with that stated as the reason.
3. Re-run **only** the affected arms — the 10 Anthropic arms, plus the max-effort arms — under a new
   pipeline sha, and report old and new side by side rather than overwriting.
4. The 16 clean arms (`luna`, `sol`, `terra`, `sonnet-5` at low/medium/high/xhigh, plus `sol` max)
   need no re-run and already answer H1 on their own.

## What the clean arms already support

Restricting to arms with **zero** author failures — 17 of 30 — H1 still fails:

| model | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| `gpt-5.6-luna` | 0.65 | 0.70 | 0.65 | 0.60 | *(4 errors)* |
| `gpt-5.6-sol` | **0.75** | 0.70 | **0.75** | 0.65 | 0.65 |
| `gpt-5.6-terra` | 0.70 | 0.65 | 0.70 | 0.60 | *(20 errors)* |
| `claude-sonnet-5` | 0.55 | 0.65 | 0.65 | 0.65 | *(19 errors)* |

Flat to declining, every CI overlapping, across four independent models. `gpt-5.6-sol` is the only
model in the sweep that completed **100/100** attempts at every effort level, which on the evidence
available is the strongest single result here — and it is a reliability result, not a quality one.
