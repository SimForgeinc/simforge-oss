# Lead state — 2026-08-16 (post-inheritance)

## Branch
Working branch is `tg-rethink` (NOT training-grade-lane). Contains: training-grade-lane
through W8/W9 completion (merged), the dead prior lead's rethink work
(reports/tg-research/, tools/tg-research/), and my rethink work (RETHINK-PLAN.md,
RETHINK-CONTRACTS.md, tools/research/). Pushed to origin/tg-rethink.
Note: my early pull --rebase loop rewrote the prior lead's commit SHAs (content intact).

## W8/W9 (Mac, now merged and committed)
- H1 FALSIFIED: effort does not raise admission on the compiler surface (30 arms).
- H2 partial: sol "never worse", all CIs overlap. H3 not supported.
- W9 production sol/low: DEV 0.7397 / HELDOUT 0.6815 — not statistically distinguishable
  from W7 luna/medium. Reliability separates models more than quality.
- => cheap default config sol/low; effort question stays open ONLY for freedom surfaces.

## Prior dead lead (same handoff, started 2026-08-15 23:29, I am the restart successor)
- Plan at reports/tg-research/PLAN.md — same diagnosis as mine, three streams:
  openvocab (~FreeformLane), instrument (~FootageLane+census), worldgen (~EmergentLane).
- Tooling under tools/tg-research/ partially built; worldgen M1 diversity probe GO
  (J_spawn 0.043); some files deleted post-commit — history at c3ab4c0, 58cb59a, 377094a.
- My streams mandated to reuse/supersede explicitly (hub broadcast sent).

## My live streams (hub ids)
FreeformLane, FootageLane, EmergentLane, EngineLane, VistaLane — all running.
Owner amendments folded in: gpt-5.6 model×effort sweeps in authoring+judging;
VistaLane added by owner instruction (faithful VISTA harness, gate-as-win-condition);
footage review pass is an owner mandate; owner edge-case list at OWNER-EDGE-CASES.md.

## Infra
auth-gateway on :4141 (hub name auth-gateway, persist). dev-assets synced (all 5 maps
present). pnpm 11.18.0, repo built. .venv/bin/python has httpx. Disk ~60 GB free — watch it.
